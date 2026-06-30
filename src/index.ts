import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
// starts at epoch 993 to 978
interface ValidatorInfo {
    identity: String,
    voteAccount: String,
    blocks: Number,
    avgFees: Number,
    avgTip: Number,
    stake: Number,
    comission: Number,
    votes: Number,
    inflationRewards: Number
}

interface ValidatorStats {
    identity: String,
    voteAccount: String,
    client: String,
    blocks: Number,
    avgFees: Number,
    avgTip: Number,
    stake: Number,
    comission: Number,
    votes: Number,
    inflationRewards: Number
}

var validatorsInfo: ValidatorInfo[] = [];

const CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../report/firedancer_reports_validators_2026-06-28_mtd_min_stake_0_all.csv",
);

const setValidatorInfo = async () => {
    const raw = readFileSync(CSV_PATH, "utf-8");

    // Let csv-parse handle quoting, escaped quotes, and (crucially) newlines
    // embedded inside quoted fields such as the free-text "details" column.
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        relax_column_count: true,
    }) as Record<string, string>[];

    // Inflation rewards are credited to vote accounts, not node identities, so
    // resolve each validator's vote account via RPC. This must hard-fail if the
    // RPC call errors or a validator has no matching vote account.
    const voteAccounts = await withRetry(
        () => connection.getVoteAccounts(),
        "getVoteAccounts",
    );

    const identityToVote = new Map<string, string>();
    for (const account of [...voteAccounts.current, ...voteAccounts.delinquent]) {
        identityToVote.set(account.nodePubkey, account.votePubkey);
    }

    var invalidPubkeys = 0;
    validatorsInfo = records.map((record) => {
        const identity = record["leader"] ?? "";
        var voteAccount = identityToVote.get(identity);
        if (!voteAccount) {
            voteAccount = PublicKey.default.toString();
            invalidPubkeys += 1;
        }

        return {
            identity,
            voteAccount,
            blocks: Number(record["blocks"] ?? 0),
            avgFees: Number(record["avg_fee"] ?? 0),
            avgTip: Number(record["avg_tips"] ?? 0),
            stake: Number(record["active_stake"] ?? 0),
            comission: Number(record["commission"] ?? 0),
            votes: Number(record["votes"] ?? 0),
            inflationRewards: 0,
        };
    });
    console.log(invalidPubkeys, "pubkeys out of ", validatorsInfo.length, "are invalid");
};

// A private/dedicated endpoint is strongly recommended here: getInflationReward
// over hundreds of validators x 15 epochs is heavy and the public endpoint
// rate-limits aggressively. Swap this URL for your own RPC provider if needed.
const RPC_URL = "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC_URL, "confirmed");

// Number of epochs to look back over.
const EPOCH_LOOKBACK = 15;

// getInflationReward accepts an array of addresses; keep batches small enough
// that the public RPC doesn't reject/throttle the request.
const ADDRESSES_PER_REQUEST = 20;

// Small delay between requests to stay under rate limits.
const REQUEST_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry with exponential backoff so transient errors / 429s don't abort the run.
const withRetry = async <T>(
    fn: () => Promise<T>,
    label: string,
    retries = 5,
): Promise<T> => {
    let delay = 1000;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries) throw err;
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(`${label} failed (attempt ${attempt + 1}/${retries}); retrying in ${delay}ms: ${reason}`);
            await sleep(delay);
            delay *= 2;
        }
    }
    throw new Error("unreachable");
};

const getValidatorInflatioinReward = async () => {
    // The current epoch is still in progress and has no rewards yet, so start
    // from the previous epoch and walk back EPOCH_LOOKBACK completed epochs.
    const { epoch: currentEpoch } = await withRetry(
        () => connection.getEpochInfo(),
        "getEpochInfo",
    );

    const epochs: number[] = [];
    for (let e = currentEpoch - 1; e >= 0 && epochs.length < EPOCH_LOOKBACK; e--) {
        epochs.push(e);
    }

    console.log("fetching epoch rewards from: ", epochs[1], "to ", epochs[epochs.length - 1])

    const addresses = validatorsInfo.map((v) => new PublicKey(String(v.voteAccount))).filter((v) => v.toString() != PublicKey.default.toString());

    for (const epoch of epochs) {
        for (let start = 0; start < addresses.length; start += ADDRESSES_PER_REQUEST) {
            const batch = addresses.slice(start, start + ADDRESSES_PER_REQUEST);
            const rewards = await withRetry(
                () => connection.getInflationReward(batch, epoch),
                `getInflationReward (epoch ${epoch}, offset ${start})`,
            );
            await sleep(REQUEST_DELAY_MS);

            const fetched = Math.min(start + batch.length, addresses.length);
            console.log(`Epoch ${epoch}: fetched ${fetched}/${addresses.length} addresses`);

            for (let j = 0; j < rewards.length; j++) {
                const reward = rewards[j];
                if (!reward) continue;

                const validator = validatorsInfo[start + j];
                if (validator) {
                    validator.inflationRewards = Number(validator.inflationRewards) + reward.amount;
                }
            }
        }
    }
};

const OUTPUT_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../report/validators_with_inflation_rewards.csv",
);

const writeValidatorInfo = () => {
    const columns: (keyof ValidatorInfo)[] = [
        "identity",
        "voteAccount",
        "blocks",
        "avgFees",
        "avgTip",
        "stake",
        "comission",
        "votes",
        "inflationRewards",
    ];

    // csv-stringify handles header generation and quoting/escaping for us.
    const output = stringify(validatorsInfo, { header: true, columns });

    writeFileSync(OUTPUT_CSV_PATH, output, "utf-8");
    console.log(`Wrote ${validatorsInfo.length} validators to ${OUTPUT_CSV_PATH}`);
};

const STATS_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../report/val_stats.csv",
);

// Joins the computed inflation-reward CSV with the "client" column from the
// original Firedancer report (matched on validator identity) and writes the
// combined rows to val_stats.csv. This reads both files from disk, so it does
// not depend on re-running the RPC pipeline.
const writeValidatorStats = () => {
    const rewardRecords = parse(readFileSync(OUTPUT_CSV_PATH, "utf-8"), {
        columns: true,
        skip_empty_lines: true,
        bom: true,
    }) as Record<string, string>[];

    const sourceRecords = parse(readFileSync(CSV_PATH, "utf-8"), {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        relax_column_count: true,
    }) as Record<string, string>[];

    const identityToClient = new Map<string, string>();
    for (const record of sourceRecords) {
        identityToClient.set(record["leader"] ?? "", record["client"] ?? "");
    }

    const stats: ValidatorStats[] = rewardRecords.map((record) => {
        const identity = record["identity"] ?? "";
        return {
            identity,
            voteAccount: record["voteAccount"] ?? "",
            client: identityToClient.get(identity) ?? "",
            blocks: Number(record["blocks"] ?? 0),
            avgFees: Number(record["avgFees"] ?? 0),
            avgTip: Number(record["avgTip"] ?? 0),
            stake: Number(record["stake"] ?? 0),
            comission: Number(record["comission"] ?? 0),
            votes: Number(record["votes"] ?? 0),
            inflationRewards: Number(record["inflationRewards"] ?? 0),
        };
    });

    const columns: (keyof ValidatorStats)[] = [
        "identity",
        "voteAccount",
        "client",
        "blocks",
        "avgFees",
        "avgTip",
        "stake",
        "comission",
        "votes",
        "inflationRewards",
    ];

    const output = stringify(stats, { header: true, columns });

    writeFileSync(STATS_CSV_PATH, output, "utf-8");
    console.log(`Wrote ${stats.length} validator stats to ${STATS_CSV_PATH}`);
};

// await setValidatorInfo();
// console.log(`Loaded ${validatorsInfo.length} validators`);

// await getValidatorInflatioinReward();
// console.log(validatorsInfo[0]);

// writeValidatorInfo();

writeValidatorStats();
