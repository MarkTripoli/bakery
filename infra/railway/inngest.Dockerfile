# Self-hosted Inngest for the Railway QA project: the upstream image pinned by
# digest (same pin as infra/compose.yaml) plus a start script that keeps every
# secret out of the process arguments. Build from the repository root:
#   docker build -f infra/railway/inngest.Dockerfile -t bakery-inngest .
FROM inngest/inngest:v1.44.0@sha256:d5365a31f8bf504dc2d54ddd114fcdc1a0413f8b57a450365c095ab6234ad8c2
COPY --chmod=0555 infra/railway/inngest-start.sh /usr/local/bin/inngest-start.sh
CMD ["bash", "/usr/local/bin/inngest-start.sh"]
