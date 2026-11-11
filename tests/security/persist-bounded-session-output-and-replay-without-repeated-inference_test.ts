import { archiveSecurityTests } from "../helpers/output-ingestion.ts";
import { securityTests } from "../helpers/output-ingestion.ts";
import { transcriptSecurityTests } from "../helpers/output-transcript.ts";
securityTests();

archiveSecurityTests();
transcriptSecurityTests();
