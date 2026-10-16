# On-call

- **Rotation:** weekly, two people (primary and secondary), hand-over Monday 11:00 IST with the
  open incidents, tickets and any risky changes of the week. No one is on call more than one week
  in four; the incident lead rotation is separate.
- **Paging:** Prometheus Alertmanager → the paging service. `severity: page` alerts page the
  primary, then the secondary after 10 minutes without acknowledgement, then the engineering
  lead after 20. `severity: ticket` alerts open tickets only. Every alert names its runbook.
- **Response targets:** acknowledge a page within 5 minutes; start the runbook within 15.
- **Access:** on-call engineers hold the break-glass role (`kubectl` on the application
  namespaces, read access to logs, metrics and the AWS console) through just-in-time elevation
  for the shift; every use is logged (CloudTrail, EKS audit log). Database writes go through the
  migrator role only during an incident, with the incident lead's agreement, and are recorded in
  the incident timeline.
- **Tools:** Grafana (dashboards per service, the SLO burn view), Loki (logs, by `event`),
  Alertmanager silences (always with an expiry and a reason), the status page.
- **Escalation:** security events go to the security lead at once (incident-response.md); legal
  clocks start at detection.
- **Hand-off note template:** what fired, what was done, what is still open, what to watch.
