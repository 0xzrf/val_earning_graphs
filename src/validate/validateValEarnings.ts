import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const JITO_VALIDATORS_URL = "https://kobe.mainnet.jito.network/api/v1/validators";
const EPOCH_START = 981;
const EPOCH_END = 996;

const CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/val_stats3.csv",
);

interface JitoValidator {
    vote_account: string;
    running_jito: boolean;
    running_bam: boolean;
}

interface JitoValidatorsResponse {
    validators: JitoValidator[];
}

async function fetchValidatorsForEpoch(epoch: number): Promise<JitoValidator[]> {
    const response = await fetch(JITO_VALIDATORS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epoch }),
    });

    if (!response.ok) {
        throw new Error(`epoch ${epoch}: HTTP ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as JitoValidatorsResponse;
    return data.validators;
}

function epochValidatorKey(epoch: number, voteAccount: string): string {
    return `${epoch}:${voteAccount}`;
}

(async () => {
    const raw = readFileSync(CSV_PATH, "utf-8");
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
    }) as Record<string, string>[];

    const jitoByEpochAndVote = new Map<string, { is_jito: boolean; is_bam: boolean }>();

    for (let epoch = EPOCH_START; epoch <= EPOCH_END; epoch++) {
        const validators = await fetchValidatorsForEpoch(epoch);
        for (const v of validators) {
            jitoByEpochAndVote.set(epochValidatorKey(epoch, v.vote_account), {
                is_jito: v.running_jito,
                is_bam: v.running_bam,
            });
        }
        console.log(`epoch ${epoch}: fetched ${validators.length} validators`);
    }

    let matched = 0;
    let unmatched = 0;

    for (const row of records) {
        const epoch = Number(row["epoch"]);
        const voteAccount = row["vote_account"] ?? "";
        const flags = jitoByEpochAndVote.get(epochValidatorKey(epoch, voteAccount));

        if (flags) {
            row["is_jito"] = String(flags.is_jito);
            row["is_bam"] = String(flags.is_bam);
            matched++;
        } else {
            row["is_jito"] = "";
            row["is_bam"] = "";
            unmatched++;
        }
    }

    const columns = Object.keys(records[0] ?? {});
    const output = stringify(records, { header: true, columns });
    writeFileSync(CSV_PATH, output, "utf-8");

    console.log(`Wrote ${records.length} rows to ${CSV_PATH}`);
    console.log(`Matched: ${matched}, unmatched: ${unmatched}`);
})();
