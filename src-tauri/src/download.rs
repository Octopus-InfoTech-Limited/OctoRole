//! Resumable download with SHA-256 verification.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::recipe::Download;

async fn hash_file(path: &Path) -> Result<(Sha256, u64)> {
    let mut f = fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hasher, total))
}

fn stamp_path(dest: &Path) -> std::path::PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".sha256");
    s.into()
}

/// True when `dest` is already present and known good.
pub async fn is_complete(item: &Download, dest: &Path) -> bool {
    let Ok(meta) = fs::metadata(dest).await else { return false };
    if meta.len() != item.bytes {
        return false;
    }
    matches!(fs::read_to_string(stamp_path(dest)).await, Ok(s) if s.trim().eq_ignore_ascii_case(&item.sha256))
}

/// Download `item` to `dest`. `on_bytes` receives the number of bytes on disk so far.
pub async fn fetch(
    client: &reqwest::Client,
    item: &Download,
    dest: &Path,
    hf_token: Option<&str>,
    cancel: &CancellationToken,
    mut on_bytes: impl FnMut(u64),
) -> Result<()> {
    if is_complete(item, dest).await {
        on_bytes(item.bytes);
        return Ok(());
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).await?;
    }

    // A full-size file without a stamp (e.g. copied in by hand) only needs hashing.
    if let Ok(meta) = fs::metadata(dest).await {
        if meta.len() == item.bytes {
            let (h, _) = hash_file(dest).await?;
            if hex::encode(h.finalize()).eq_ignore_ascii_case(&item.sha256) {
                fs::write(stamp_path(dest), &item.sha256).await?;
                on_bytes(item.bytes);
                return Ok(());
            }
        }
        fs::remove_file(dest).await.ok();
    }

    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = std::path::PathBuf::from(part);

    let (mut hasher, mut have) = match fs::metadata(&part).await {
        Ok(m) if m.len() > 0 && m.len() <= item.bytes => hash_file(&part).await?,
        Ok(_) => {
            fs::remove_file(&part).await.ok();
            (Sha256::new(), 0)
        }
        Err(_) => (Sha256::new(), 0),
    };

    if have < item.bytes {
        let url = url::Url::parse(&item.url)?;
        let mut req = client.get(url.clone());
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        if let (Some(tok), Some(host)) = (hf_token, url.host_str()) {
            if host == "huggingface.co" || host.ends_with(".huggingface.co") {
                req = req.bearer_auth(tok);
            }
        }
        let resp = req.send().await.with_context(|| format!("request {}", item.url))?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            bail!("access denied ({status}) for {} - this file may need a Hugging Face token or licence acceptance", item.url);
        }
        if !status.is_success() {
            bail!("HTTP {status} for {}", item.url);
        }
        let mut file = if status == reqwest::StatusCode::PARTIAL_CONTENT && have > 0 {
            fs::OpenOptions::new().append(true).open(&part).await?
        } else {
            // Server ignored the range: start over.
            hasher = Sha256::new();
            have = 0;
            fs::File::create(&part).await?
        };
        on_bytes(have);

        let mut stream = resp.bytes_stream();
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => {
                    file.flush().await.ok();
                    return Err(anyhow!("cancelled"));
                }
                c = stream.next() => c,
            };
            let Some(chunk) = chunk else { break };
            let chunk = chunk.context("download interrupted")?;
            file.write_all(&chunk).await?;
            hasher.update(&chunk);
            have += chunk.len() as u64;
            if have > item.bytes {
                drop(file);
                fs::remove_file(&part).await.ok();
                bail!("{} is larger than the recipe says", item.to);
            }
            on_bytes(have);
        }
        file.flush().await?;
    }

    if have != item.bytes {
        bail!("download of {} stopped early ({have} of {} bytes) - retry to resume", item.to, item.bytes);
    }
    let got = hex::encode(hasher.finalize());
    if !got.eq_ignore_ascii_case(&item.sha256) {
        fs::remove_file(&part).await.ok();
        bail!("checksum mismatch for {} (got {got})", item.to);
    }
    fs::rename(&part, dest).await?;
    fs::write(stamp_path(dest), &item.sha256).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accepts_existing_good_file_and_rejects_wrong_size() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.bin");
        fs::write(&dest, b"hello").await.unwrap();
        let item = Download {
            url: "https://invalid.invalid/m.bin".into(),
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
            bytes: 5,
            to: "m.bin".into(),
            license: None,
        };
        assert!(!is_complete(&item, &dest).await);
        let client = reqwest::Client::new();
        fetch(&client, &item, &dest, None, &CancellationToken::new(), |_| {}).await.unwrap();
        assert!(is_complete(&item, &dest).await);

        fs::write(&dest, b"hell").await.unwrap();
        assert!(!is_complete(&item, &dest).await);
    }

    /// Needs network. Run with: cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn resumes_partial_download() {
        let item = Download {
            url: "https://raw.githubusercontent.com/comfyanonymous/ComfyUI/10cdd12609eb17e8a90f2a2dd811b1c82f6107e7/README.md".into(),
            sha256: "7b4ef883d0f634223598f4d03f42773e408b6ccbfb1f340fb54f321bef6f9dde".into(),
            bytes: 29340,
            to: "README.md".into(),
            license: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("README.md");
        let client = reqwest::Client::new();
        let cancel = CancellationToken::new();

        fetch(&client, &item, &dest, None, &cancel, |_| {}).await.unwrap();
        let full = fs::read(&dest).await.unwrap();
        assert_eq!(full.len() as u64, item.bytes);

        // Simulate an interrupted download: keep the first half as .part.
        fs::remove_file(&dest).await.unwrap();
        fs::remove_file(stamp_path(&dest)).await.unwrap();
        fs::write(dir.path().join("README.md.part"), &full[..full.len() / 2]).await.unwrap();
        let mut first = None;
        fetch(&client, &item, &dest, None, &cancel, |n| {
            first.get_or_insert(n);
        })
        .await
        .unwrap();
        assert_eq!(fs::read(&dest).await.unwrap(), full);
        assert!(first.unwrap() > 0, "resume should start from the bytes already on disk");

        // A corrupted partial file must be rejected, not accepted.
        fs::remove_file(&dest).await.unwrap();
        fs::remove_file(stamp_path(&dest)).await.unwrap();
        let mut bad = full[..full.len() / 2].to_vec();
        bad[0] ^= 0xff;
        fs::write(dir.path().join("README.md.part"), &bad).await.unwrap();
        let err = fetch(&client, &item, &dest, None, &cancel, |_| {}).await.unwrap_err();
        assert!(err.to_string().contains("checksum mismatch"), "{err}");
        assert!(!dest.exists());
    }
}
