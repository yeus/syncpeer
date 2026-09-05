use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CacheRange {
    pub offset: u64,
    pub size: u64,
}

#[derive(Deserialize, Serialize)]
pub struct RangeDigest {
    pub offset: u64,
    pub size: u64,
    pub hash: Vec<u8>,
}

fn consume_range(source: &mut (impl Read + Seek), range: &CacheRange, mut consume: impl FnMut(&[u8]) -> std::io::Result<()>) -> std::io::Result<()> {
    source.seek(SeekFrom::Start(range.offset))?;
    let mut buffer = vec![0; 256 * 1024];
    let mut remaining = range.size;
    while remaining > 0 {
        let count = remaining.min(buffer.len() as u64) as usize;
        source.read_exact(&mut buffer[..count])?;
        consume(&buffer[..count])?;
        remaining -= count as u64;
    }
    Ok(())
}

pub fn digest_range(source: &mut (impl Read + Seek), range: &CacheRange) -> std::io::Result<Vec<u8>> {
    let mut hash = Sha256::new();
    consume_range(source, range, |bytes| { hash.update(bytes); Ok(()) })?;
    Ok(hash.finalize().to_vec())
}

pub fn copy_range(source: &mut (impl Read + Seek), target: &mut (impl Write + Seek), range: &CacheRange) -> std::io::Result<()> {
    target.seek(SeekFrom::Start(range.offset))?;
    consume_range(source, range, |bytes| target.write_all(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn digest_and_copy_requested_ranges() {
        let mut source = Cursor::new(vec![1, 2, 3, 4, 5, 6]);
        let range = CacheRange { offset: 2, size: 3 };
        let hash = digest_range(&mut source, &range).unwrap();
        assert_eq!(hash, Sha256::digest([3, 4, 5]).to_vec());
        let mut target = Cursor::new(vec![0; 6]);
        copy_range(&mut source, &mut target, &range).unwrap();
        assert_eq!(target.into_inner(), vec![0, 0, 3, 4, 5, 0]);
    }

    #[test]
    fn truncated_source_fails() {
        let mut source = Cursor::new(vec![1, 2]);
        assert!(digest_range(&mut source, &CacheRange { offset: 1, size: 3 }).is_err());
    }
}
