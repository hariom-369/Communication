# staging (its own AWS account). Values marked "set" are decisions of the operator.
environment          = "staging"
domain               = "set: the registered domain"
name_prefix          = "set: a globally unique bucket prefix, e.g. tessera-staging-<random>"
container_registry   = "set: ghcr.io/<owner>"
vpc_cidr             = "10.41.0.0/16"
admin_access_cidrs   = ["set: the access proxy's addresses"]
admin_oidc_issuer    = "set: https://<corporate identity provider>"
admin_email_domains  = "set: the staff e-mail domain"
general_node         = { instance_types = ["m7i.large"], min = 3, max = 6, desired = 3 }
media_node           = { instance_types = ["c7i.large"], min = 2, max = 3, desired = 2 }
database             = { instance_class = "db.r7g.large", allocated_storage = 50, max_allocated_storage = 200 }
valkey_node_type     = "cache.t4g.medium"
deploy_role_subjects = ["repo:set-owner/set-repo:environment:staging"]
