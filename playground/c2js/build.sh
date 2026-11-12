#!/bin/sh
# 在 c2js 目录内执行：用 Emscripten 把 index.c 编译成单文件 JS 模块
cd "$(dirname "$0")"
emcc -s "SINGLE_FILE=1" -s "MODULARIZE=1" -s "ALLOW_MEMORY_GROWTH=1" -s "EXPORT_NAME=createModule" -s "EXPORTED_FUNCTIONS=['_get_persons', '_malloc', '_free']" -s "EXPORTED_RUNTIME_METHODS=['cwrap', 'setValue', 'getValue', 'AsciiToString', 'writeStringToMemory']" -o ./index.js ./index.c
