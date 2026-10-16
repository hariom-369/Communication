# PostgreSQL (RDS, Multi-AZ, PITR 35 days) and Valkey (ElastiCache, Multi-AZ, TLS, auth token)
# — docs/database.md, docs/disaster-recovery.md §1–2. Both live in the data subnets and accept
# connections only from the node subnets.

variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "client_cidrs" { type = list(string) }
variable "database" {
  type = object({ instance_class = string, allocated_storage = number, max_allocated_storage = number })
}
variable "valkey_node_type" { type = string }
variable "production" { type = bool }

resource "aws_kms_key" "data" {
  description             = "${var.name} databases"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  # Multi-region, so snapshot copies in the DR region decrypt with a replica of this key.
  multi_region = true
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

# --- PostgreSQL --------------------------------------------------------------------------------

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "database" {
  name        = "${var.name}-postgres"
  description = "PostgreSQL from the node subnets"
  vpc_id      = var.vpc_id
  ingress {
    description = "PostgreSQL"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.client_cidrs
  }
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg17"
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    # Statements over 1 s are logged without parameters (no user data in logs).
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
}

resource "aws_db_instance" "this" {
  identifier                      = var.name
  engine                          = "postgres"
  engine_version                  = "17"
  instance_class                  = var.database.instance_class
  allocated_storage               = var.database.allocated_storage
  max_allocated_storage           = var.database.max_allocated_storage
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  db_name                         = "tessera"
  username                        = "tessera_admin"
  manage_master_user_password     = true
  multi_az                        = true
  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  parameter_group_name            = aws_db_parameter_group.this.name
  publicly_accessible             = false
  backup_retention_period         = 35
  backup_window                   = "20:00-21:00"
  maintenance_window              = "sun:21:30-sun:22:30"
  copy_tags_to_snapshot           = true
  deletion_protection             = var.production
  skip_final_snapshot             = !var.production
  final_snapshot_identifier       = var.production ? "${var.name}-final" : null
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
  auto_minor_version_upgrade      = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
}

# --- Valkey -----------------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "valkey" {
  name        = "${var.name}-valkey"
  description = "Valkey from the node subnets"
  vpc_id      = var.vpc_id
  ingress {
    description = "Valkey (TLS)"
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = var.client_cidrs
  }
}

resource "random_password" "valkey" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "valkey" {
  name       = "${var.name}/valkey-auth"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "valkey" {
  secret_id     = aws_secretsmanager_secret.valkey.id
  secret_string = random_password.valkey.result
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = var.name
  description                = "Tessera ${var.name}: rate limits, realtime fan-out, presence, queues"
  engine                     = "valkey"
  engine_version             = "8.0"
  node_type                  = var.valkey_node_type
  num_cache_clusters         = 3
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.valkey.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.valkey.result
  port                       = 6379
  # Disposable state (docs/architecture.md §10): no snapshots needed for recovery.
  snapshot_retention_limit = 0
  apply_immediately        = false
}

output "database_arn" { value = aws_db_instance.this.arn }
output "database_endpoint" { value = aws_db_instance.this.address }
output "master_secret_arn" { value = aws_db_instance.this.master_user_secret[0].secret_arn }
output "valkey_endpoint" { value = aws_elasticache_replication_group.this.primary_endpoint_address }
output "valkey_auth_secret_arn" { value = aws_secretsmanager_secret.valkey.arn }
output "kms_key_arn" { value = aws_kms_key.data.arn }
