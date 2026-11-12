// tcping-lib.rs
extern crate wasm_bindgen;
extern crate wasm_bindgen_futures;
extern crate tokio;
extern crate web_sys;
use wasm_bindgen::JsValue;

use std::net::{SocketAddr};
use std::time::{Instant};

use wasm_bindgen::prelude::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;


#[wasm_bindgen]
pub async fn connect(host: &str, port: u16, timeout: u64) -> Result<(), JsValue> {
    let addr = format!("{}:{}", host, port);
    let addr = addr.parse::<SocketAddr>().unwrap();

    let start = Instant::now();
    let mut stream = match TcpStream::connect(addr).await {
        Ok(stream) => stream,
        Err(e) => return Err(JsValue::from_str(&format!("Could not connect to {}: {}", addr, e))),
    };

    stream.set_nodelay(true);
    stream.write_all(b"ping").await;
    let mut buf = [0u8; 4];
    let n = match stream.read(&mut buf).await {
      Ok(n) => n,
      Err(e) => return Err(JsValue::from_str(&format!("Could not read from stream: {}", e))),
    };
    if n != 4 || buf != *b"pong" {
        return Err(JsValue::from_str("Unexpected response from server"));
    }

    let elapsed = start.elapsed().as_millis() as u64;
    // console::log_1(&JsValue::from(format!("Connected to {} in {}ms", addr, elapsed)));

    if elapsed > timeout {
        Err(JsValue::from_str(&format!("Connection took too long ({}ms)", elapsed)))
    } else {
        stream.shutdown().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_connect() {
        connect("google.com", 80, 1000).await.unwrap();
    }
}
