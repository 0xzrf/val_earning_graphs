import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js"
import BN from "bn.js"
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const JITO_API_BASE = "https://kobe.mainnet.jito.network/api/v1";
const RPC_URL = "https://api.mainnet-beta.solana.com";

const VAL_STATS_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/val_stats.csv",
);

const VAL_STATS2_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/val_stats2.csv",
);

const connection = new Connection(RPC_URL, "confirmed");

// getInflationReward accepts an array of addresses; keep batches small enough
// that the public RPC doesn't reject/throttle the request.
const ADDRESSES_PER_REQUEST = 20;
const REQUEST_DELAY_MS = 2_000;

/** A single validator entry from the Jito Stake Pool API. */
export interface JitoValidator {
    identity_account: string;
    vote_account: string;
    mev_commission_bps: number;
    mev_rewards: number;
    priority_fee_commission_bps: number;
    priority_fee_rewards: number;
    bam_connection_rate: number;
    active_stake: string;
    jito_directed_stake_target: boolean;
    jito_directed_stake_lamports: string;
    running_jito: boolean,
    running_bam: boolean
}

interface ValidatorInfo {
    name: string,
    client: string,
    identity_account: string;
    vote_account: string;
    mev_commission_bps: number;
    mev_rewards: number;
    priority_fee_commission_bps: number;
    priority_fee_rewards: number;
    avg_stake: BN,
    epoch: number,
    inflationRewards: number
}

var valInfo: ValidatorInfo[] = [];

interface JitoValidatorsResponse {
    validators: JitoValidator[];
}

// Lamport fields from the API can exceed Number.MAX_SAFE_INTEGER. JSON.parse
// turns them into imprecise floats, which makes `new BN(number)` throw.
const parseValidatorsResponse = (text: string): JitoValidatorsResponse => {
    const normalized = text
        .replace(/"active_stake":(\d+)/g, '"active_stake":"$1"')
        .replace(/"jito_directed_stake_lamports":(\d+)/g, '"jito_directed_stake_lamports":"$1"');

    return JSON.parse(normalized) as JitoValidatorsResponse;
};

const toStakeBn = (activeStake: string): BN => new BN(activeStake);

/**
 * Fetches inflation rewards for all validators in `valInfo` whose `epoch`
 * matches `targetEpoch`, batching RPC calls and setting `inflationRewards`
 * on each entry once its reward is retrieved.
 */
const fetchInflationRewardsForEpoch = async (targetEpoch: number) => {
    const epochValidators = valInfo.filter((validator) => validator.epoch === targetEpoch);
    if (epochValidators.length === 0) return;

    const voteAccounts = epochValidators.map((v) => new PublicKey(v.vote_account));

    for (let start = 0; start < voteAccounts.length; start += ADDRESSES_PER_REQUEST) {
        const batch = voteAccounts.slice(start, start + ADDRESSES_PER_REQUEST);
        let rewards;
        try {
            rewards = await withRetry(
                () => connection.getInflationReward(batch, targetEpoch),
                `getInflationReward (epoch ${targetEpoch}, offset ${start})`,
                (err) => !String(err).includes("Block not available"),
            );
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (reason.includes("Block not available")) {
                console.log(`Skipping epoch ${targetEpoch} inflation rewards: epoch not finalized yet`);
                return;
            }
            throw err;
        }
        await sleep(REQUEST_DELAY_MS);

        const fetched = Math.min(start + batch.length, voteAccounts.length);
        console.log(`Epoch ${targetEpoch} inflation: fetched ${fetched}/${voteAccounts.length} vote accounts`);

        for (let j = 0; j < rewards.length; j++) {
            const reward = rewards[j];
            if (!reward) continue;

            const validator = epochValidators[start + j];
            if (validator) {
                validator.inflationRewards = reward.amount;
            }
        }
    }
};

/**
 * Fetches all JitoSOL validators for the current epoch (or a specific epoch)
 * via POST https://kobe.mainnet.jito.network/api/v1/validators
 *
 * @see https://www.jito.network/docs/jitosol/jitosol-liquid-staking/for-developers/stake-pool-api/#2-jitosol-validators
 */
const fetchValidatorsForEpoch = async (
    targetEpoch: number,
): Promise<{ validators: JitoValidator[] }> => {
    const response = await fetch(`${JITO_API_BASE}/validators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epoch: targetEpoch }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Jito API ${response.status} ${response.statusText}: ${body}`);
    }

    const data = parseValidatorsResponse(await response.text());

    console.log("data", data)
    return {
        validators: data.validators,
    };
};

const PAST_EPOCH_LIMIT = 15;
const API_CALL_INTERVAL = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async <T>(
    fn: () => Promise<T>,
    label: string,
    shouldRetry: (err: unknown) => boolean = () => true,
    retries = 5,
): Promise<T> => {
    let delay = 1000;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries || !shouldRetry(err)) throw err;
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(`${label} failed (attempt ${attempt + 1}/${retries}); retrying in ${delay}ms: ${reason}`);
            await sleep(delay);
            delay *= 2;
        }
    }
    throw new Error("unreachable");
};

/** Returns the current epoch from Solana RPC. */
const fetchCurrentEpoch = async (): Promise<number> => {
    const epochInfo = await withRetry(
        () => connection.getEpochInfo(),
        "getEpochInfo",
    );
    return epochInfo.epoch;
};

const enrichValidatorNamesFromValStats = () => {
    const valStats2Records = parse(readFileSync(VAL_STATS2_CSV_PATH, "utf-8"), {
        columns: true,
        skip_empty_lines: true,
        bom: true,
    }) as Record<string, string>[];

    const valStatsRecords = parse(readFileSync(VAL_STATS_CSV_PATH, "utf-8"), {
        columns: true,
        skip_empty_lines: true,
        bom: true,
    }) as Record<string, string>[];

    const identityToCommissionVotes = new Map<string, { comission: string; votes: string }>();
    for (const record of valStatsRecords) {
        identityToCommissionVotes.set(record["identity"] ?? "", {
            comission: record["comission"] ?? "",
            votes: record["votes"] ?? "",
        });
    }

    const enriched = valStats2Records.map((record) => {
        const meta = identityToCommissionVotes.get(record["identity_account"] ?? "");
        return {
            ...record,
            comission: meta?.comission ?? "",
            votes: meta?.votes ?? "",
        };
    });

    const columns = [
        "name",
        "client",
        "identity_account",
        "vote_account",
        "mev_commission_bps",
        "mev_rewards",
        "priority_fee_commission_bps",
        "priority_fee_rewards",
        "avg_stake",
        "epoch",
        "inflationRewards",
        "comission",
        "votes",
    ];

    const output = stringify(enriched, { header: true, columns });
    writeFileSync(VAL_STATS2_CSV_PATH, output, "utf-8");
    console.log(`Wrote ${enriched.length} rows to ${VAL_STATS2_CSV_PATH}`);
};

const writeValInfoToCsv = () => {
    const columns: (keyof ValidatorInfo)[] = [
        "name",
        "client",
        "identity_account",
        "vote_account",
        "mev_commission_bps",
        "mev_rewards",
        "priority_fee_commission_bps",
        "priority_fee_rewards",
        "avg_stake",
        "epoch",
        "inflationRewards",
    ];

    const rows = valInfo.map((validator) => ({
        ...validator,
        avg_stake: validator.avg_stake.toString(),
    }));

    const output = stringify(rows, { header: true, columns });
    writeFileSync(VAL_STATS2_CSV_PATH, output, "utf-8");
    console.log(`Wrote ${valInfo.length} validators to ${VAL_STATS2_CSV_PATH}`);
};

export const getValidatorInfo = async () => {
    // valInfo = [];

    // const epoch = await fetchCurrentEpoch();

    // // The current epoch is still in progress — inflation rewards aren't available
    // // until it completes (same as firedancerScripts/infor.ts).
    // for (let targetEpoch = epoch - 1; targetEpoch >= epoch - PAST_EPOCH_LIMIT && targetEpoch >= 0; targetEpoch--) {
    //     console.log("fetching epoch:", targetEpoch);
    //     const { validators } = await fetchValidatorsForEpoch(targetEpoch);

    //     for (const item of validators) {
    //         valInfo.push({
    //             name: "",
    //             client: "",
    //             identity_account: item.identity_account,
    //             vote_account: item.vote_account,
    //             mev_commission_bps: item.mev_commission_bps,
    //             mev_rewards: item.mev_rewards,
    //             priority_fee_commission_bps: item.priority_fee_commission_bps,
    //             priority_fee_rewards: item.priority_fee_rewards,
    //             avg_stake: toStakeBn(item.active_stake),
    //             epoch: targetEpoch,
    //             inflationRewards: 0,
    //         });
    //     }

    //     await fetchInflationRewardsForEpoch(targetEpoch);
    //     await sleep(API_CALL_INTERVAL);
    // }

    enrichValidatorNamesFromValStats();
};