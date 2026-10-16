# VPC over three availability zones (docs/deployment.md §2):
# - public:  load balancers, NAT gateways
# - private: Kubernetes nodes (general pool), interface endpoints
# - data:    PostgreSQL and Valkey; no route to the internet
# - media:   coturn and LiveKit nodes with public addresses (UDP media goes straight to them)

variable "name" { type = string }
variable "cidr" { type = string }
variable "azs" { type = list(string) }
variable "region" { type = string }

locals {
  # /20 blocks: public 0-2, private 3-5, data 6-8, media 9-11.
  subnets = {
    public  = [for i in range(3) : cidrsubnet(var.cidr, 4, i)]
    private = [for i in range(3) : cidrsubnet(var.cidr, 4, 3 + i)]
    data    = [for i in range(3) : cidrsubnet(var.cidr, 4, 6 + i)]
    media   = [for i in range(3) : cidrsubnet(var.cidr, 4, 9 + i)]
  }
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.subnets.public[count.index]
  availability_zone = var.azs[count.index]
  tags              = {
    Name = "${var.name}-public-${var.azs[count.index]}"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "private" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.subnets.private[count.index]
  availability_zone = var.azs[count.index]
  tags              = {
    Name = "${var.name}-private-${var.azs[count.index]}"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_subnet" "data" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.subnets.data[count.index]
  availability_zone = var.azs[count.index]
  tags              = { Name = "${var.name}-data-${var.azs[count.index]}" }
}

resource "aws_subnet" "media" {
  count                   = 3
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.subnets.media[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-media-${var.azs[count.index]}" }
}

resource "aws_eip" "nat" {
  count  = 3
  domain = "vpc"
  tags   = { Name = "${var.name}-nat-${var.azs[count.index]}" }
}

resource "aws_nat_gateway" "this" {
  count         = 3
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${var.name}-${var.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 3
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "media" {
  count          = 3
  subnet_id      = aws_subnet.media[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = 3
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[count.index].id
  }
  tags = { Name = "${var.name}-private-${var.azs[count.index]}" }
}

resource "aws_route_table_association" "private" {
  count          = 3
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Data subnets: local routes only.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-data" }
}

resource "aws_route_table_association" "data" {
  count          = 3
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# S3 without the internet (media, breached-password mirror), and the AWS APIs the services and
# nodes use, as interface endpoints in the private subnets.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.private[*].id, [aws_route_table.public.id])
  tags              = { Name = "${var.name}-s3" }
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "Interface VPC endpoints: HTTPS from the VPC"
  vpc_id      = aws_vpc.this.id
  ingress {
    description = "HTTPS and SMTPS from the VPC"
    from_port   = 443
    to_port     = 465
    protocol    = "tcp"
    cidr_blocks = [var.cidr]
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["kms", "secretsmanager", "sts", "ecr.api", "ecr.dkr", "logs", "email-smtp", "eks-auth"])
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "${var.name}-${each.key}" }
}

# Flow logs for incident investigation (CERT-In: 180 days of ICT logs).
resource "aws_cloudwatch_log_group" "flow" {
  name              = "/tessera/${var.name}/vpc-flow"
  retention_in_days = 180
}

data "aws_iam_policy_document" "flow_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "flow" {
  name               = "${var.name}-vpc-flow"
  assume_role_policy = data.aws_iam_policy_document.flow_assume.json
}

data "aws_iam_policy_document" "flow" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.flow.arn}:*"]
  }
}

resource "aws_iam_role_policy" "flow" {
  role   = aws_iam_role.flow.id
  policy = data.aws_iam_policy_document.flow.json
}

resource "aws_flow_log" "this" {
  vpc_id          = aws_vpc.this.id
  traffic_type    = "ALL"
  log_destination = aws_cloudwatch_log_group.flow.arn
  iam_role_arn    = aws_iam_role.flow.arn
}

output "vpc_id" { value = aws_vpc.this.id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "private_subnet_cidrs" { value = local.subnets.private }
output "data_subnet_ids" { value = aws_subnet.data[*].id }
output "data_subnet_cidrs" { value = local.subnets.data }
output "media_subnet_ids" { value = aws_subnet.media[*].id }
output "media_subnet_cidrs" { value = local.subnets.media }
output "s3_endpoint_id" { value = aws_vpc_endpoint.s3.id }
