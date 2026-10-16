# The public edge (docs/deployment.md §2): app.<domain> is CloudFront with WAF in front of the
# public ALB, which the AWS Load Balancer Controller creates from infra/k8s (Ingress "public")
# and external-dns names origin.<domain>. The ALB admits only CloudFront; the internal admin
# ALB only the identity-aware access proxy. TLS certificates come from ACM.

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.global]
    }
  }
}

variable "name" { type = string }
variable "domain" { type = string }
variable "vpc_id" { type = string }
variable "admin_access_cidrs" { type = list(string) }

data "aws_route53_zone" "this" {
  name = var.domain
}

# --- Certificates -----------------------------------------------------------------------------

resource "aws_acm_certificate" "regional" {
  domain_name               = var.domain
  subject_alternative_names = ["*.${var.domain}"]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "cloudfront" {
  provider          = aws.global
  domain_name       = "app.${var.domain}"
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

locals {
  validations = merge(
    { for o in aws_acm_certificate.regional.domain_validation_options : o.resource_record_name => o },
    { for o in aws_acm_certificate.cloudfront.domain_validation_options : o.resource_record_name => o },
  )
}

resource "aws_route53_record" "validation" {
  for_each        = local.validations
  zone_id         = data.aws_route53_zone.this.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "regional" {
  certificate_arn         = aws_acm_certificate.regional.arn
  validation_record_fqdns = [for o in aws_acm_certificate.regional.domain_validation_options : o.resource_record_name]
  depends_on              = [aws_route53_record.validation]
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider                = aws.global
  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for o in aws_acm_certificate.cloudfront.domain_validation_options : o.resource_record_name]
  depends_on              = [aws_route53_record.validation]
}

# --- Load balancer security groups (referenced by infra/k8s) ----------------------------------

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "public_alb" {
  name        = "${var.name}-public-alb"
  description = "Public ALB: HTTPS from CloudFront only"
  vpc_id      = var.vpc_id
  ingress {
    description     = "HTTPS from CloudFront"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
}

resource "aws_security_group" "admin_alb" {
  name        = "${var.name}-admin-alb"
  description = "Admin ALB: HTTPS from the identity-aware access proxy only"
  vpc_id      = var.vpc_id
  ingress {
    description = "HTTPS from the access proxy"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.admin_access_cidrs
  }
}

# --- WAF --------------------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "this" {
  provider = aws.global
  name     = var.name
  scope    = "CLOUDFRONT"
  default_action {
    allow {}
  }
  rule {
    name     = "common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
        # Encrypted message bodies and key packages are large opaque payloads.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = false
    }
  }
  rule {
    name     = "known-bad-inputs"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "known-bad-inputs"
      sampled_requests_enabled   = false
    }
  }
  rule {
    name     = "ip-reputation"
    priority = 3
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "ip-reputation"
      sampled_requests_enabled   = false
    }
  }
  rule {
    # Outer flood limit per address (the API's own limits are per account and route; CGNAT
    # means this must stay generous, docs/security.md §7).
    name     = "rate-per-address"
    priority = 4
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 6000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-per-address"
      sampled_requests_enabled   = false
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = false
  }
}

# --- CloudFront -------------------------------------------------------------------------------

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "origin_headers" {
  name = "UseOriginCacheControlHeaders"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  aliases         = ["app.${var.domain}"]
  web_acl_id      = aws_wafv2_web_acl.this.arn
  price_class     = "PriceClass_200"

  origin {
    origin_id   = "alb"
    domain_name = "origin.${var.domain}"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }
  }

  # Static files: the web tier's Cache-Control decides (hashed assets for a year, the shell and
  # release files revalidated).
  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.origin_headers.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    compress                 = true
  }

  # API, realtime (WebSocket) and SFU signalling: never cached, everything forwarded.
  dynamic "ordered_cache_behavior" {
    for_each = ["/api/*", "/rt/*", "/sfu/*"]
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = "alb"
      viewer_protocol_policy   = "https-only"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
      compress                 = false
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cloudfront.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "app" {
  for_each = toset(["A", "AAAA"])
  zone_id  = data.aws_route53_zone.this.zone_id
  name     = "app.${var.domain}"
  type     = each.key
  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}

output "public_alb_security_group_id" { value = aws_security_group.public_alb.id }
output "admin_alb_security_group_id" { value = aws_security_group.admin_alb.id }
output "regional_certificate_arn" { value = aws_acm_certificate_validation.regional.certificate_arn }
output "cloudfront_domain" { value = aws_cloudfront_distribution.this.domain_name }
