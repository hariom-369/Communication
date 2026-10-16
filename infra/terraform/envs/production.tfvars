# production (its own AWS account). Values marked "set" are decisions of the operator.
environment          = "production"
domain               = "set: the registered domain"
name_prefix          = "set: a globally unique bucket prefix, e.g. tessera-production-<random>"
container_registry   = "set: ghcr.io/<owner>"
vpc_cidr             = "10.40.0.0/16"
admin_access_cidrs   = ["set: the access proxy's addresses"]
admin_oidc_issuer    = "set: https://<corporate identity provider>"
admin_email_domains  = "set: the staff e-mail domain"
general_node         = { instance_types = ["m7i.2xlarge"], min = 3, max = 12, desired = 4 }
media_node           = { instance_types = ["c7i.2xlarge"], min = 3, max = 8, desired = 3 }
database             = { instance_class = "db.r7g.xlarge", allocated_storage = 200, max_allocated_storage = 2000 }
valkey_node_type     = "cache.r7g.large"
deploy_role_subjects = ["repo:set-owner/set-repo:environment:production"]
