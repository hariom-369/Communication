# Input for infra/k8s (`values.json` without `release` and `images`, which the release adds):
# stored as the GitHub environment variable K8S_VALUES_<ENVIRONMENT> (docs/deployment.md §4).
output "k8s_values" {
  value = jsonencode({
    environment              = var.environment
    domain                   = var.domain
    registry                 = var.container_registry
    awsRegion                = var.region
    vpcCidr                  = var.vpc_cidr
    dataSubnetCidrs          = module.network.data_subnet_cidrs
    mediaSubnetCidrs         = module.network.media_subnet_cidrs
    publicAlbSecurityGroupId = module.edge.public_alb_security_group_id
    adminAlbSecurityGroupId  = module.edge.admin_alb_security_group_id
    mediaBucket              = module.storage.media_bucket
    pwnedPasswordsBucket     = module.storage.pwned_passwords_bucket
    certificateArn           = module.edge.regional_certificate_arn
    adminOidcIssuer          = var.admin_oidc_issuer
    adminEmailDomains        = var.admin_email_domains
  })
}

output "cluster_name" {
  value = module.eks.cluster_name
}

output "deploy_role_arn" {
  value = module.eks.deploy_role_arn
}

output "database_endpoint" {
  value = module.data.database_endpoint
}

output "database_master_secret_arn" {
  description = "Secrets Manager secret of the RDS master user (used only by ops/db/roles.sql)."
  value       = module.data.master_secret_arn
}

output "valkey_endpoint" {
  value = module.data.valkey_endpoint
}

output "cloudfront_domain" {
  value = module.edge.cloudfront_domain
}
