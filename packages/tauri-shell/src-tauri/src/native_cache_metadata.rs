use crate::metadata_sqlite::MetadataDatabase;
use serde::{de::DeserializeOwned, Serialize};
use std::{fs, path::Path};

pub struct NativeCacheMetadata {
    database: MetadataDatabase,
}

impl NativeCacheMetadata {
    pub fn open(metadata_root: &Path, cache_root: &Path, key: &[u8; 32]) -> Result<Self, String> {
        MetadataDatabase::open(metadata_root, cache_root, "native-cache-v1", key)
            .map(|database| Self { database })
            .map_err(|error| error.to_string())
    }

    pub fn load<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>, String> {
        self.database
            .get("private", name)
            .map_err(|error| error.to_string())?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
            .transpose()
    }

    pub fn load_or_migrate<T>(&self, name: &str, legacy: &Path) -> Result<Option<T>, String>
    where
        T: DeserializeOwned + PartialEq + Serialize,
    {
        let stored = self.load::<T>(name)?;
        if !legacy.exists() {
            return Ok(stored);
        }
        let plaintext = fs::read(legacy)
            .map_err(|error| format!("Could not read {}: {error}", legacy.display()))?;
        let decoded = serde_json::from_slice::<T>(&plaintext)
            .map_err(|error| format!("Could not parse {}: {error}", legacy.display()))?;
        if let Some(stored) = stored {
            if stored != decoded {
                return Err(format!("Encrypted metadata conflicts with {}", legacy.display()));
            }
            fs::remove_file(legacy)
                .map_err(|error| format!("Could not remove {}: {error}", legacy.display()))?;
            return Ok(Some(stored));
        }
        self.database.put("private", name, &plaintext, 0)
            .map_err(|error| error.to_string())?;
        let verified = self.database.get("private", name)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Encrypted metadata read-back failed".to_string())?;
        if verified != plaintext {
            return Err("Encrypted metadata read-back changed the migrated value".into());
        }
        fs::remove_file(legacy)
            .map_err(|error| format!("Could not remove {}: {error}", legacy.display()))?;
        Ok(Some(decoded))
    }

    pub fn save<T: Serialize>(&self, name: &str, value: &T) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        self.database.put("private", name, &bytes, 0)
            .map_err(|error| error.to_string())?;
        if self.database.get("private", name).map_err(|error| error.to_string())?.as_deref()
            != Some(bytes.as_slice())
        {
            return Err("Encrypted metadata read-back changed the saved value".into());
        }
        Ok(())
    }

    pub fn list<T: DeserializeOwned>(&self, prefix: &str) -> Result<Vec<(String, T)>, String> {
        self.names(prefix)?.into_iter()
            .map(|name| {
                let value = self.load(&name)?
                    .ok_or_else(|| "Encrypted metadata entry disappeared".to_string())?;
                Ok((name, value))
            })
            .collect()
    }

    pub fn names(&self, prefix: &str) -> Result<Vec<String>, String> {
        Ok(self.database.entries().map_err(|error| error.to_string())?
            .into_iter()
            .filter(|entry| entry.name.starts_with(prefix))
            .map(|entry| entry.name)
            .collect())
    }

    pub fn remove(&self, name: &str) -> Result<(), String> {
        self.database.remove(name).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::NativeCacheMetadata;
    use serde::{Deserialize, Serialize};
    use std::fs;

    #[derive(Debug, Default, Deserialize, PartialEq, Serialize)]
    struct Fixture {
        private_name: String,
    }

    #[test]
    fn migrates_plaintext_only_after_encrypted_readback() {
        let temp = tempfile::tempdir().unwrap();
        let metadata = temp.path().join("metadata");
        let cache = temp.path().join("cache");
        let legacy = temp.path().join("cache-index.json");
        let marker = "synthetic-private-name";
        fs::write(&legacy, format!(r#"{{"private_name":"{marker}"}}"#)).unwrap();

        let store = NativeCacheMetadata::open(&metadata, &cache, &[7; 32]).unwrap();
        let migrated: Fixture = store.load_or_migrate("index", &legacy).unwrap().unwrap();
        assert_eq!(migrated.private_name, marker);
        assert!(!legacy.exists());
        drop(store);

        let encrypted = fs::read_dir(metadata.join("folders"))
            .unwrap()
            .flat_map(|entry| fs::read_dir(entry.unwrap().path()).unwrap())
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("metadata.sqlite3"))
            .map(|entry| fs::read(entry.path()).unwrap())
            .collect::<Vec<_>>();
        assert!(!encrypted.is_empty());
        assert!(encrypted.iter().all(|bytes| !bytes.windows(marker.len()).any(|part| part == marker.as_bytes())));

        let reopened = NativeCacheMetadata::open(&metadata, &cache, &[7; 32]).unwrap();
        assert_eq!(reopened.load::<Fixture>("index").unwrap().unwrap(), migrated);
    }

    #[test]
    fn preserves_invalid_or_conflicting_plaintext_during_migration() {
        let temp = tempfile::tempdir().unwrap();
        let metadata = temp.path().join("metadata");
        let cache = temp.path().join("cache");
        let legacy = temp.path().join("partial.json");
        fs::write(&legacy, b"not-json").unwrap();
        let store = NativeCacheMetadata::open(&metadata, &cache, &[7; 32]).unwrap();
        assert!(store.load_or_migrate::<Fixture>("partial/one", &legacy).is_err());
        assert!(legacy.exists());

        store.save("partial/one", &Fixture { private_name: "stored".into() }).unwrap();
        fs::write(&legacy, br#"{"private_name":"different"}"#).unwrap();
        assert!(store.load_or_migrate::<Fixture>("partial/one", &legacy).is_err());
        assert!(legacy.exists());
    }
}
