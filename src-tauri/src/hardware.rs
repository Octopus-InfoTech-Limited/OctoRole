use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Hardware {
    pub arch: String,
    pub os: String,
    pub os_version: String,
    pub chip: String,
    pub memory_gb: f64,
    pub disk_free_gb: f64,
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn memory_bytes() -> u64 {
    if let Some(v) = run("sysctl", &["-n", "hw.memsize"]).and_then(|s| s.parse::<u64>().ok()) {
        return v;
    }
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|t| {
            t.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<u64>().ok())
        })
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

/// Free space on the volume holding `dir` (walks up to the nearest existing parent).
pub fn disk_free_bytes(dir: &Path) -> u64 {
    let mut probe = dir.to_path_buf();
    while !probe.exists() {
        if !probe.pop() {
            break;
        }
    }
    let Some(out) = run("df", &["-Pk", probe.to_string_lossy().as_ref()]) else {
        return 0;
    };
    out.lines()
        .nth(1)
        .and_then(|l| l.split_whitespace().nth(3))
        .and_then(|kb| kb.parse::<u64>().ok())
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

pub fn detect(root: &Path) -> Hardware {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    Hardware {
        arch: std::env::consts::ARCH.to_string(),
        os: std::env::consts::OS.to_string(),
        os_version: run("sw_vers", &["-productVersion"]).unwrap_or_default(),
        chip: run("sysctl", &["-n", "machdep.cpu.brand_string"]).unwrap_or_default(),
        memory_gb: (memory_bytes() as f64 / GB * 10.0).round() / 10.0,
        disk_free_gb: (disk_free_bytes(root) as f64 / GB * 10.0).round() / 10.0,
    }
}

/// PATH for child processes. GUI apps on macOS start with a bare PATH, so
/// Homebrew and user-local bins have to be added by hand.
pub fn child_path(tools: &Path) -> String {
    let mut parts = vec![tools.join("bin").to_string_lossy().to_string()];
    if let Some(home) = dirs::home_dir() {
        parts.push(home.join(".local/bin").to_string_lossy().to_string());
        parts.push(home.join(".cargo/bin").to_string_lossy().to_string());
    }
    for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        parts.push(p.to_string());
    }
    if let Ok(cur) = std::env::var("PATH") {
        parts.push(cur);
    }
    parts.join(":")
}
