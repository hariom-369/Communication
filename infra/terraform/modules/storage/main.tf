# Object storage (docs/media.md §5, docs/deployment.md §5): encrypted attachments (ciphertext
# only; browsers upload and download with presigned URLs), the breached-password mirror (read
# only through the VPC endpoint), and audit exports under Object Lock.

variable "name_prefix" { type = string }
variable "app_origin" { type = string }
variable "vpc_endpoint_s3" { type = string }

resource "aws_kms_key" "storage" {
  description             = "${var.name_prefix} object storage"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "storage" {
  name          = "alias/${var.name_prefix}-storage"
  target_key_id = aws_kms_key.storage.key_id
}

# --- Encrypted attachments --------------------------------------------------------------------

resource "aws_s3_bucket" "media" {
  bucket = "${var.name_prefix}-media"
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.storage.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "abandoned-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  rule {
    # Deleted attachments: keep the previous version 7 days (recovery from operator error),
    # then it is gone (the retention promise, docs/privacy.md §4).
    id     = "deleted-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    expiration {
      expired_object_delete_marker = true
    }
  }
}

# Browsers upload parts and download ciphertext directly (presigned URLs; the CSP names this
# origin, infra/images/nginx/render.mjs --media-origin).
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_origins = [var.app_origin]
    allowed_methods = ["PUT", "GET"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 600
  }
}

data "aws_iam_policy_document" "media" {
  statement {
    sid     = "TlsOnly"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media.json
}

# --- Breached-password mirror ----------------------------------------------------------------

resource "aws_s3_bucket" "pwned" {
  bucket = "${var.name_prefix}-pwned"
}

resource "aws_s3_bucket_public_access_block" "pwned" {
  bucket                  = aws_s3_bucket.pwned.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The API reads `range/<prefix>` without signing (fetch with no credentials), so reads are
# allowed only through this VPC's S3 endpoint; nothing else can read or list the bucket.
data "aws_iam_policy_document" "pwned" {
  statement {
    sid     = "ReadThroughVpcEndpoint"
    actions = ["s3:GetObject"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = ["${aws_s3_bucket.pwned.arn}/range/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceVpce"
      values   = [var.vpc_endpoint_s3]
    }
  }
  statement {
    sid     = "TlsOnly"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.pwned.arn, "${aws_s3_bucket.pwned.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "pwned" {
  bucket = aws_s3_bucket.pwned.id
  policy = data.aws_iam_policy_document.pwned.json
  # The public-access block refuses a policy with a "*" principal unless it is scoped by a
  # condition like aws:SourceVpce (which makes it non-public), so the order matters.
  depends_on = [aws_s3_bucket_public_access_block.pwned]
}

# --- Audit exports (Object Lock, compliance mode) ----------------------------------------------

resource "aws_s3_bucket" "audit" {
  bucket              = "${var.name_prefix}-audit"
  object_lock_enabled = true
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.storage.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    default_retention {
      mode  = "COMPLIANCE"
      years = 1
    }
  }
}

output "media_bucket" { value = aws_s3_bucket.media.bucket }
output "media_bucket_arn" { value = aws_s3_bucket.media.arn }
output "pwned_passwords_bucket" { value = aws_s3_bucket.pwned.bucket }
output "audit_bucket" { value = aws_s3_bucket.audit.bucket }
output "kms_key_arn" { value = aws_kms_key.storage.arn }
