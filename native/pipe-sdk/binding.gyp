{
  "targets": [
    {
      "target_name": "pipe_sdk",
      "sources": ["src/addon.cpp"],
      "include_dirs": ["sdk"],
      "defines": ["NAPI_VERSION=8", "NOMINMAX", "WIN32_LEAN_AND_MEAN"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    }
  ]
}
