# terraform init -backend-config=envs/staging.backend.hcl (state bucket and lock table are created
# once per account by hand, with versioning and KMS encryption; the state holds the Valkey auth
# token, so access to it is access to that secret).
bucket       = "set: the state bucket"
key          = "tessera/staging.tfstate"
region       = "ap-south-1"
encrypt      = true
use_lockfile = true
