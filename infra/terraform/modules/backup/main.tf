# Platform backups (docs/disaster-recovery.md §2): daily RDS snapshots in a locked vault, copied
# to the DR region. RDS's own automated backups (35 days, point-in-time recovery) are configured
# on the instance; this adds copies that survive the loss of the region and, with the vault lock,
# deletion by a compromised account administrator.

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.dr]
    }
  }
}

variable "name" { type = string }
variable "database_arn" { type = string }
variable "locked" {
  description = "Vault lock in compliance mode (production): recovery points cannot be deleted early by anyone."
  type        = bool
}

resource "aws_kms_key" "backup" {
  description         = "${var.name} backups"
  enable_key_rotation = true
}

resource "aws_kms_key" "backup_dr" {
  provider            = aws.dr
  description         = "${var.name} backups (DR region)"
  enable_key_rotation = true
}

resource "aws_backup_vault" "primary" {
  name        = var.name
  kms_key_arn = aws_kms_key.backup.arn
}

resource "aws_backup_vault" "dr" {
  provider    = aws.dr
  name        = "${var.name}-dr"
  kms_key_arn = aws_kms_key.backup_dr.arn
}

resource "aws_backup_vault_lock_configuration" "primary" {
  count               = var.locked ? 1 : 0
  backup_vault_name   = aws_backup_vault.primary.name
  min_retention_days  = 7
  max_retention_days  = 400
  changeable_for_days = 3
}

resource "aws_backup_vault_lock_configuration" "dr" {
  count               = var.locked ? 1 : 0
  provider            = aws.dr
  backup_vault_name   = aws_backup_vault.dr.name
  min_retention_days  = 7
  max_retention_days  = 400
  changeable_for_days = 3
}

resource "aws_backup_plan" "this" {
  name = var.name
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 21 * * ? *)" # 02:30 IST
    start_window      = 60
    completion_window = 360
    lifecycle {
      delete_after = 35
    }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle {
        delete_after = 35
      }
    }
  }
  rule {
    rule_name         = "monthly"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 22 1 * ? *)"
    lifecycle {
      delete_after = 365
    }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle {
        delete_after = 365
      }
    }
  }
}

data "aws_iam_policy_document" "assume_backup" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.assume_backup.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "database" {
  name         = "database"
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [var.database_arn]
}

output "vault_arn" { value = aws_backup_vault.primary.arn }
output "dr_vault_arn" { value = aws_backup_vault.dr.arn }
