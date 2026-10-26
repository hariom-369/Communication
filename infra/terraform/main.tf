# Tessera infrastructure for one environment (docs/deployment.md §2). Applied per AWS account:
#   terraform init -backend-config=envs/<env>.backend.hcl
#   terraform apply -var-file=envs/<env>.tfvars
# Cluster add-ons (AWS Load Balancer Controller, External Secrets Operator, cert-manager,
# external-dns, Prometheus Operator) are installed after this with their upstream charts and
# IAM policies (README.md); the application manifests come from infra/k8s.

locals {
  name = "tessera-${var.environment}"
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

module "network" {
  source = "./modules/network"
  name   = local.name
  cidr   = var.vpc_cidr
  azs    = slice(data.aws_availability_zones.available.names, 0, 3)
  region = var.region
}

module "storage" {
  providers = {
    aws    = aws
    aws.dr = aws.dr
  }
  source          = "./modules/storage"
  name_prefix     = var.name_prefix
  app_origin      = "https://app.${var.domain}"
  vpc_endpoint_s3 = module.network.s3_endpoint_id
}

module "data" {
  source           = "./modules/data"
  name             = local.name
  vpc_id           = module.network.vpc_id
  subnet_ids       = module.network.data_subnet_ids
  client_cidrs     = module.network.private_subnet_cidrs
  database         = var.database
  valkey_node_type = var.valkey_node_type
  production       = var.environment == "production"
}

module "eks" {
  source               = "./modules/eks"
  name                 = local.name
  kubernetes_version   = var.eks_version
  vpc_id               = module.network.vpc_id
  private_subnet_ids   = module.network.private_subnet_ids
  media_subnet_ids     = module.network.media_subnet_ids
  public_access_cidrs  = var.eks_public_access_cidrs
  general_node         = var.general_node
  media_node           = var.media_node
  media_bucket_arn     = module.storage.media_bucket_arn
  media_kms_key_arn    = module.storage.kms_key_arn
  secrets_prefix       = "tessera/${var.environment}/"
  deploy_role_subjects = var.deploy_role_subjects
  account_id           = data.aws_caller_identity.current.account_id
}

module "edge" {
  source = "./modules/edge"
  providers = {
    aws        = aws
    aws.global = aws.global
  }
  name               = local.name
  domain             = var.domain
  vpc_id             = module.network.vpc_id
  admin_access_cidrs = var.admin_access_cidrs
}

module "backup" {
  source = "./modules/backup"
  providers = {
    aws    = aws
    aws.dr = aws.dr
  }
  name         = local.name
  database_arn = module.data.database_arn
  locked       = var.environment == "production"
}
