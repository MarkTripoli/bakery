import { archiveRecoveryTests } from "../helpers/output-ingestion.ts";
import { recoveryTests } from "../helpers/output-ingestion.ts";
import { transcriptRecoveryTests } from "../helpers/output-transcript.ts";
recoveryTests();

archiveRecoveryTests();
import { tasklessArchiveTests } from "../helpers/output-ingestion.ts";
tasklessArchiveTests();
transcriptRecoveryTests();
import { transcriptReviewRegressionTests } from "../helpers/output-transcript.ts";
transcriptReviewRegressionTests();
import { transcriptUpgradeRegressionTests } from "../helpers/output-transcript.ts";
transcriptUpgradeRegressionTests();
