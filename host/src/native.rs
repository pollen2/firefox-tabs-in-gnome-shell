//! Firefox native messaging framing: a native-endian u32 length, then UTF-8 JSON.

use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Firefox accepts at most 1 MiB per message sent to the extension.
const MAX_OUTGOING: usize = 1024 * 1024;
/// Our own cap on what we accept, so a broken extension can't make us allocate gigabytes.
const MAX_INCOMING: usize = 64 * 1024 * 1024;

/// Returns `None` on a clean end of stream (Firefox closed the port).
pub async fn read_message<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match reader.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_ne_bytes(len) as usize;
    if len > MAX_INCOMING {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("message too large: {len} bytes")));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

pub async fn write_message<W: AsyncWrite + Unpin>(writer: &mut W, json: &[u8]) -> io::Result<()> {
    if json.len() > MAX_OUTGOING {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "message exceeds 1 MiB"));
    }
    writer.write_all(&(json.len() as u32).to_ne_bytes()).await?;
    writer.write_all(json).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trip() {
        let mut buf = Vec::new();
        write_message(&mut buf, br#"{"a":1}"#).await.unwrap();
        let mut reader = &buf[..];
        assert_eq!(read_message(&mut reader).await.unwrap().unwrap(), br#"{"a":1}"#);
        assert!(read_message(&mut reader).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_oversized_length() {
        let len = ((MAX_INCOMING + 1) as u32).to_ne_bytes();
        let mut reader = &len[..];
        assert!(read_message(&mut reader).await.is_err());
    }
}
