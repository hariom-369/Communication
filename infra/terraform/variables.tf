variable "environment" {
  description = "staging or production (separate AWS accounts, docs/deployment.md §1)."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "dr_region" {
  type    = string
  default = "ap-south-2"
}

variable "domain" {
  description = "Apex domain; a Route 53 hosted zone for it must exist in this account."
  type        = string
}

variable "name_prefix" {
  description = "Globally unique prefix for bucket names, e.g. tessera-prod-7f3a."
  type        = string
}

variable "vpc_cidr" {
  type = string
}

variable "eks_version" {
  type    = string
  default = "1.34"
}

variable "eks_public_access_cidrs" {
  description = "Addresses allowed to reach the Kubernetes API endpoint (deploy runners, break-glass). Empty: private endpoint only."
  type        = list(string)
  default     = []
}

variable "admin_access_cidrs" {
  description = "Addresses of the identity-aware access proxy in front of the admin console."
  type        = list(string)
}

variable "admin_oidc_issuer" {
  type = string
}

variable "admin_email_domains" {
  type = string
}

variable "general_node" {
  type = object({ instance_types = list(string), min = number, max = number, desired = number })
}

variable "media_node" {
  type = object({ instance_types = list(string), min = number, max = number, desired = number })
}

variable "database" {
  type = object({ instance_class = string, allocated_storage = number, max_allocated_storage = number })
}

variable "valkey_node_type" {
  type = string
}

variable "deploy_role_subjects" {
  description = "GitHub OIDC subjects allowed to deploy, e.g. repo:<owner>/<repo>:environment:production."
  type        = list(string)
}

variable "container_registry" {
  description = "Where the release workflow publishes the images, e.g. ghcr.io/<owner>."
  type        = string
}
