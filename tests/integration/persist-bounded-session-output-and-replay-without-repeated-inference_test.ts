import { archiveIntegrationTests } from "../helpers/output-ingestion.ts";
import { integrationTests } from "../helpers/output-ingestion.ts";
import { transcriptIntegrationTests } from "../helpers/output-transcript.ts";
integrationTests();

archiveIntegrationTests();
transcriptIntegrationTests();
