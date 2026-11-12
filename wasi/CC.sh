export WASI_SDK_PATH=$HOME/wasi-sdk-20.0

CC="clang --target=wasm32-wasi --sysroot=${WASI_SDK_PATH}/share/wasi-sysroot"

CC ./wasi-app.c -o ./wasi-app.wasm