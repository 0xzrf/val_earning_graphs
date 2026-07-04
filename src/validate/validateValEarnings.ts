// Fetch per-epoch earnings for every vote account in val_stats2.csv and write val_stats3.csv
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const LAMPORTS_PER_SOL = 1_000_000_000;
const REQUEST_DELAY_MS = 1_000;

const VAL_STATS2_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/val_stats2.csv",
);

const VAL_STATS3_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/val_stats3.csv",
);

const FIREDCANCER_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/firedancer_reports_validators_2026-06-28_mtd_min_stake_0_all.csv",
);

/** Per-epoch SOL/USD prices from the reference earnings table (epochs 981–996). */
const SOL_PRICE_BY_EPOCH: Record<number, number> = {
    981: 74.99,
    982: 62.81,
    983: 66.06,
    984: 64.48,
    985: 66.15,
    986: 68.15,
    987: 74.44,
    988: 71.7,
    989: 69.97,
    990: 73.55,
    991: 69.61,
    992: 67.9,
    993: 70.78,
    994: 73.98,
    995: 77.92,
    996: 82.64,
};

/** Epoch date ranges (DD.MM.YYYY – DD.MM.YYYY) matching the reference table. */
const EPOCH_DATES: Record<number, string> = {
    981: "02.06.2026 - 04.06.2026",
    982: "04.06.2026 - 06.06.2026",
    983: "06.06.2026 - 08.06.2026",
    984: "08.06.2026 - 10.06.2026",
    985: "10.06.2026 - 12.06.2026",
    986: "12.06.2026 - 14.06.2026",
    987: "14.06.2026 - 16.06.2026",
    988: "16.06.2026 - 18.06.2026",
    989: "18.06.2026 - 20.06.2026",
    990: "20.06.2026 - 22.06.2026",
    991: "22.06.2026 - 24.06.2026",
    992: "24.06.2026 - 26.06.2026",
    993: "26.06.2026 - 28.06.2026",
    994: "28.06.2026 - 30.06.2026",
    995: "30.06.2026 - 02.07.2026",
    996: "02.07.2026 - 04.07.2026",
};

interface StvApiResponse {
    validatorId: string;
    voteId: string;
    commissionReward: number; // inflation reward (lamports)
    votingReward: number; // leader rewards (lamports)
    votingFee: number; // fee spent on votes (lamports)
    votingCompensation: number; // voting compensation (lamports)
    jitoReward: number;
    epoch: number;
    mevCommission: number;
    totalStake: number;
}

interface EpochEarningRow {
    name: string;
    client: string;
    identity_account: string;
    vote_account: string;
    epoch: number;
    dates: string;
    leader_reward_sol: number;
    commission_sol: number;
    jito_reward_sol: number;
    voting_fee_sol: number;
    voting_compensation_sol: number;
    total_sol: number;
    total_usd: number;
    sol_price: number;
    stake_in_epoch: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toLamports = (value: string | number | undefined): number => {
    if (value === undefined || value === null || value === "") return 0;
    return Number(value);
};

const lamportsToSol = (lamports: number): number => lamports / LAMPORTS_PER_SOL;

const getApiUrl = (validator: string) => {
    return `https://api.validators.svt.one/validators-history/history?network=mainnet&vote_id=${validator}&epoch_count=16&epoch_from=996`;
};

const readUniqueVoteAccounts = (): string[] => {
    const raw = readFileSync(VAL_STATS2_CSV_PATH, "utf8");
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
    }) as Record<string, string>[];

    const voteAccounts = new Set<string>();
    for (const record of records) {
        const voteAccount = record.vote_account?.trim();
        if (voteAccount) voteAccounts.add(voteAccount);
    }
    return [...voteAccounts];
};

/** vote_account -> identity_account (first seen in val_stats2.csv). */
const readVoteToIdentityMap = (): Map<string, string> => {
    const raw = readFileSync(VAL_STATS2_CSV_PATH, "utf8");
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
    }) as Record<string, string>[];

    const map = new Map<string, string>();
    for (const record of records) {
        const voteAccount = record.vote_account?.trim();
        const identityAccount = record.identity_account?.trim();
        if (voteAccount && identityAccount && !map.has(voteAccount)) {
            map.set(voteAccount, identityAccount);
        }
    }
    return map;
};

/** leader (identity) -> { name, client } from the Firedancer report CSV. */
const readFiredancerMeta = (): Map<string, { name: string; client: string }> => {
    const raw = readFileSync(FIREDCANCER_CSV_PATH, "utf8");
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
    }) as Record<string, string>[];

    const map = new Map<string, { name: string; client: string }>();
    for (const record of records) {
        const leader = record.leader?.trim();
        if (!leader) continue;
        map.set(leader, {
            name: record.name?.trim() ?? "",
            client: record.client?.trim() ?? "",
        });
    }
    return map;
};

const fetchValidatorInfo = async (validator: string): Promise<StvApiResponse[]> => {
    const response = await fetch(getApiUrl(validator));

    if (!response.ok) {
        throw new Error(`Failed to fetch validator: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as { data: Record<string, unknown>[] };
    const rows = json.data ?? [];

    return rows.map((row) => ({
        validatorId: String(row.validatorId ?? ""),
        voteId: String(row.voteId ?? ""),
        commissionReward: toLamports(row.commissionReward as string | number),
        votingReward: toLamports(row.votingReward as string | number),
        votingFee: toLamports(row.votingFee as string | number),
        votingCompensation: toLamports(row.votingCompensation as string | number),
        jitoReward: toLamports(row.jitoReward as string | number),
        epoch: Number(row.epoch),
        mevCommission: Number(row.mevCommission ?? row.mevComission ?? 0),
        totalStake: toLamports(row.totalStake as string | number),
    }));
};

/**
 * Total SOL for an epoch:
 *   leader reward + commission + jito reward − voting fee + voting compensation
 */
const calculateEpochEarnings = (
    voteAccount: string,
    identityAccount: string,
    name: string,
    client: string,
    rows: StvApiResponse[],
): EpochEarningRow[] => {
    return rows
        .map((row) => {
            const leaderRewardSol = lamportsToSol(row.votingReward);
            const commissionSol = lamportsToSol(row.commissionReward);
            const jitoRewardSol = lamportsToSol(row.jitoReward);
            // Voting fee is a cost — shown and applied as a negative amount.
            const votingFeeSol = -lamportsToSol(row.votingFee);
            const votingCompensationSol = lamportsToSol(row.votingCompensation);
            const totalSol =
                leaderRewardSol +
                commissionSol +
                jitoRewardSol +
                votingFeeSol +
                votingCompensationSol;
            const solPrice = SOL_PRICE_BY_EPOCH[row.epoch] ?? 0;

            return {
                name,
                client,
                identity_account: identityAccount,
                vote_account: voteAccount,
                epoch: row.epoch,
                dates: EPOCH_DATES[row.epoch] ?? "",
                leader_reward_sol: leaderRewardSol,
                commission_sol: commissionSol,
                jito_reward_sol: jitoRewardSol,
                voting_fee_sol: votingFeeSol,
                voting_compensation_sol: votingCompensationSol,
                total_sol: totalSol,
                total_usd: totalSol * solPrice,
                sol_price: solPrice,
                stake_in_epoch: lamportsToSol(row.totalStake),
            };
        })
        .sort((a, b) => a.epoch - b.epoch);
};

const writeValStats3 = (rows: EpochEarningRow[]) => {
    writeFileSync(
        VAL_STATS3_CSV_PATH,
        stringify(rows, {
            header: true,
            columns: [
                "name",
                "client",
                "identity_account",
                "vote_account",
                "epoch",
                "dates",
                "leader_reward_sol",
                "commission_sol",
                "jito_reward_sol",
                "voting_fee_sol",
                "voting_compensation_sol",
                "total_sol",
                "total_usd",
                "sol_price",
                "stake_in_epoch",
            ],
        }),
    );
    console.log(`Wrote ${rows.length} rows to ${VAL_STATS3_CSV_PATH}`);
};

export const validateValEarnings = async () => {
    const voteAccounts = readUniqueVoteAccounts();
    const voteToIdentity = readVoteToIdentityMap();
    const firedancerMeta = readFiredancerMeta();

    console.log(`Found ${voteAccounts.length} unique vote accounts in val_stats2.csv`);

    const earnings: EpochEarningRow[] = [];

    for (let i = 0; i < voteAccounts.length; i++) {
        const voteAccount = voteAccounts[i]!;
        const identityAccount = voteToIdentity.get(voteAccount) ?? "";
        const meta = firedancerMeta.get(identityAccount) ?? { name: "", client: "" };

        try {
            const data = await fetchValidatorInfo(voteAccount);
            earnings.push(
                ...calculateEpochEarnings(
                    voteAccount,
                    identityAccount,
                    meta.name,
                    meta.client,
                    data,
                ),
            );
            console.log(
                `[${i + 1}/${voteAccounts.length}] ${voteAccount}: ${data.length} epochs`,
            );
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(
                `[${i + 1}/${voteAccounts.length}] ${voteAccount}: failed — ${reason}`,
            );
        }

        if (i < voteAccounts.length - 1) {
            await sleep(REQUEST_DELAY_MS);
        }
    }

    writeValStats3(earnings);
};

if (import.meta.url === `file://${process.argv[1]}`) {
    validateValEarnings().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
