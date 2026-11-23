# Modifications to MiniMax H3

These files are MODIFIED versions of the MiniMax H3 Works, redistributed under the MiniMax H3 Community License
Agreement (see LICENSE and NOTICE). They are a Model Derivative: Video Rebirth's HyperFlow H3 Flash REF2VA
(`VideoRebirthAI/hyperflow-h3-flash`), itself derived from MiniMax-H3 REF2VA.

Modified by: hancheng-ai (Hugging Face), converted with the mlx-serve converter
(`tests/convert_minimax_h3_weights.py --partition flash-ref2va`, https://github.com/ddalcu/mlx-serve).

What changed:

* `transformer.safetensors` is Video Rebirth's released Q8_0 GGUF (`ref2va_gguf/minimax_h3_ref2va_hyperflow_flash_14b-Q8_0.gguf`) dequantized and
  requantized to MLX affine 8-bit, group size 64. The fp32 islands (patch projections, output heads, time and
  endpoint-time embedders, rope inverse frequencies) are kept dense. The low-rank factors are trimmed of the zero
  rank padding the GGUF adds (ranks stay multiples of 64). Tensor names are kept. The sampling schedule and the
  two-time gate move from GGUF metadata into `config.json`. The block dropping, low-rank factoring and two-time
  distillation are Video Rebirth's; nothing was retrained, distilled or pruned in this conversion.
* `text_encoder.safetensors` is the stock MiniMax-H3 text encoder (Qwen3-VL), quantized from the original bfloat16
  release to MLX affine 4-bit, group size 64, and copied byte for byte from a stock MiniMax-H3 REF2VA MLX 4-bit pack
  (sha256 `0323dda5f35a607de923daa779fc53b813b7c882fd82d8525b7415f72853a5c5`). It is 4-bit in both the 8-bit and the 4-bit packs.
* `video_vae.safetensors` and `audio_vae.safetensors` are byte-for-byte copies of the original MiniMax-H3 VAEs,
  unmodified.
* The tokenizer files are byte-for-byte copies of the MiniMax-H3 tokenizer (`MiniMaxAI/MiniMax-H3`), relocated into
  this directory so the model is self-contained.
* `config.json` is new. The mlx-serve converter wrote it to describe the layout above. It is not from the original
  release.
