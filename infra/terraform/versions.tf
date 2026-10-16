terraform {
  required_version = ">= 1.12.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
  # Remote state with locking; configured per environment at init:
  #   terraform init -backend-config=envs/<env>.backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "tessera"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront certificates and WAF must live in us-east-1.
provider "aws" {
  alias  = "global"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = "tessera"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Cross-region backup copies (docs/disaster-recovery.md §2).
provider "aws" {
  alias  = "dr"
  region = var.dr_region
  default_tags {
    tags = {
      Project     = "tessera"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
