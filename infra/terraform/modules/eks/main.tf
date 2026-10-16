# EKS cluster (docs/deployment.md §2, §6): private nodes, secrets envelope-encrypted with KMS,
# the VPC CNI's NetworkPolicy enforcement on (infra/k8s relies on it), EKS Pod Identity for AWS
# access (no node-role permissions for workloads), and a deploy role for GitHub OIDC.

variable "name" { type = string }
variable "kubernetes_version" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "media_subnet_ids" { type = list(string) }
variable "public_access_cidrs" { type = list(string) }
variable "general_node" {
  type = object({ instance_types = list(string), min = number, max = number, desired = number })
}
variable "media_node" {
  type = object({ instance_types = list(string), min = number, max = number, desired = number })
}
variable "media_bucket_arn" { type = string }
variable "media_kms_key_arn" { type = string }
variable "secrets_prefix" { type = string }
variable "deploy_role_subjects" { type = list(string) }
variable "account_id" { type = string }

data "aws_iam_policy_document" "assume_eks" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.assume_eks.json
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_kms_key" "secrets" {
  description         = "${var.name} Kubernetes secrets"
  enable_key_rotation = true
}

resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${var.name}/cluster"
  retention_in_days = 180
}

resource "aws_eks_cluster" "this" {
  name     = var.name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn
  vpc_config {
    subnet_ids              = var.private_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = length(var.public_access_cidrs) > 0
    public_access_cidrs     = length(var.public_access_cidrs) > 0 ? var.public_access_cidrs : null
  }
  access_config {
    authentication_mode = "API"
  }
  encryption_config {
    resources = ["secrets"]
    provider {
      key_arn = aws_kms_key.secrets.arn
    }
  }
  enabled_cluster_log_types = ["api", "audit", "authenticator"]
  depends_on                = [aws_iam_role_policy_attachment.cluster, aws_cloudwatch_log_group.cluster]
}

# --- Nodes ------------------------------------------------------------------------------------

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-node"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# The listen backlog the services ask for (LISTEN_BACKLOG=4096) only takes effect up to
# net.core.somaxconn, which restricted pods cannot set; nodes set it (docs/deployment.md §5).
locals {
  user_data = <<-EOT
    MIME-Version: 1.0
    Content-Type: multipart/mixed; boundary="//"

    --//
    Content-Type: text/x-shellscript; charset="us-ascii"

    #!/bin/bash
    set -euo pipefail
    printf 'net.core.somaxconn = 4096\nnet.ipv4.tcp_max_syn_backlog = 8192\n' > /etc/sysctl.d/90-tessera.conf
    sysctl --system
    --//--
  EOT
}

resource "aws_launch_template" "node" {
  for_each  = toset(["general", "media"])
  name      = "${var.name}-${each.key}"
  user_data = base64encode(local.user_data)
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1 # pods cannot reach the node's instance metadata
    http_endpoint               = "enabled"
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 50
      volume_type = "gp3"
      encrypted   = true
    }
  }
  vpc_security_group_ids = each.key == "media" ? [aws_eks_cluster.this.vpc_config[0].cluster_security_group_id, aws_security_group.media.id] : null
}

resource "aws_eks_node_group" "general" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "general"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids
  instance_types  = var.general_node.instance_types
  ami_type        = "AL2023_x86_64_STANDARD"
  scaling_config {
    min_size     = var.general_node.min
    max_size     = var.general_node.max
    desired_size = var.general_node.desired
  }
  update_config {
    max_unavailable = 1
  }
  launch_template {
    id      = aws_launch_template.node["general"].id
    version = aws_launch_template.node["general"].latest_version
  }
  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
  depends_on = [aws_iam_role_policy_attachment.node]
}

# Media nodes: public addresses, host-networked coturn and LiveKit only (taint), UDP media open
# to the internet, signalling (7880) to the VPC only.
resource "aws_security_group" "media" {
  name        = "${var.name}-media"
  description = "TURN and SFU media"
  vpc_id      = var.vpc_id
  ingress {
    description = "TURN UDP"
    from_port   = 3478
    to_port     = 3478
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "TURN over TLS"
    from_port   = 5349
    to_port     = 5349
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "SFU media TCP"
    from_port   = 7881
    to_port     = 7881
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "SFU and relay media UDP"
    from_port   = 50000
    to_port     = 60000
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "SFU signalling and API, from the cluster"
    from_port   = 7880
    to_port     = 7880
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.this.cidr_block]
  }
}

data "aws_vpc" "this" {
  id = var.vpc_id
}

resource "aws_eks_node_group" "media" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "media"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.media_subnet_ids
  instance_types  = var.media_node.instance_types
  ami_type        = "AL2023_x86_64_STANDARD"
  scaling_config {
    min_size     = var.media_node.min
    max_size     = var.media_node.max
    desired_size = var.media_node.desired
  }
  update_config {
    max_unavailable = 1
  }
  labels = { "tessera.dev/pool" = "media" }
  taint {
    key    = "tessera.dev/media"
    value  = "true"
    effect = "NO_SCHEDULE"
  }
  launch_template {
    id      = aws_launch_template.node["media"].id
    version = aws_launch_template.node["media"].latest_version
  }
  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
  depends_on = [aws_iam_role_policy_attachment.node]
}

# --- Add-ons ----------------------------------------------------------------------------------

resource "aws_eks_addon" "vpc_cni" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "vpc-cni"
  # NetworkPolicy enforcement (infra/k8s default-deny and the link-fetcher isolation, F-05).
  configuration_values = jsonencode({ enableNetworkPolicy = "true" })
}

resource "aws_eks_addon" "standard" {
  for_each     = toset(["coredns", "kube-proxy", "eks-pod-identity-agent"])
  cluster_name = aws_eks_cluster.this.name
  addon_name   = each.key
  depends_on   = [aws_eks_node_group.general]
}

# --- Workload identities (EKS Pod Identity) ----------------------------------------------------

data "aws_iam_policy_document" "assume_pod" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

# User and admin API: the attachments bucket (presigning and the abandoned-upload sweep).
data "aws_iam_policy_document" "media" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = ["${var.media_bucket_arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [var.media_bucket_arn]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.media_kms_key_arn]
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.assume_pod.json
}

resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.media.json
}

resource "aws_eks_pod_identity_association" "api" {
  for_each        = toset(["api", "admin-api"])
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "tessera"
  service_account = each.key
  role_arn        = aws_iam_role.api.arn
}

# External Secrets Operator: read this environment's secrets only.
data "aws_iam_policy_document" "external_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["arn:aws:secretsmanager:*:${var.account_id}:secret:${var.secrets_prefix}*"]
  }
}

resource "aws_iam_role" "external_secrets" {
  name               = "${var.name}-external-secrets"
  assume_role_policy = data.aws_iam_policy_document.assume_pod.json
}

resource "aws_iam_role_policy" "external_secrets" {
  role   = aws_iam_role.external_secrets.id
  policy = data.aws_iam_policy_document.external_secrets.json
}

resource "aws_eks_pod_identity_association" "external_secrets" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "external-secrets"
  service_account = "external-secrets"
  role_arn        = aws_iam_role.external_secrets.arn
}

# --- Deploy role (GitHub Actions OIDC, deploy.yml) ----------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "assume_deploy" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = var.deploy_role_subjects
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-deploy"
  assume_role_policy   = data.aws_iam_policy_document.assume_deploy.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    actions   = ["eks:DescribeCluster"]
    resources = [aws_eks_cluster.this.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

resource "aws_eks_access_entry" "deploy" {
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = aws_iam_role.deploy.arn
}

# The deploy role administers the application namespaces only (not the cluster).
resource "aws_eks_access_policy_association" "deploy" {
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = aws_iam_role.deploy.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy"
  access_scope {
    type       = "namespace"
    namespaces = ["tessera", "tessera-media"]
  }
  depends_on = [aws_eks_access_entry.deploy]
}

output "cluster_name" { value = aws_eks_cluster.this.name }
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
