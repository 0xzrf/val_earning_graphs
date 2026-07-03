"""Interactive dashboard for Solana validator earnings (Jito / val_stats2).

Reads ../report/val_stats2.csv (one row per validator per epoch) and visualizes:
  1. Stake vs. Earning   (scatter)
  2. Client vs. Earning   (aggregated bar + per-client distribution)

Per-epoch earning:
    (mev_rewards + priority_fee_rewards + inflationRewards)

All values are shown in SOL.

The date range (2026-06-03 .. 2026-07-02) maps onto epochs 981..995
(~2 days per epoch). Partially covered epochs are excluded from the range.

Run with:
    streamlit run frontend/app.py
"""

import json
import math
from datetime import date
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import pandas as pd
import plotly.express as px
import streamlit as st

LAMPORTS_PER_SOL = 1_000_000_000

MONETARY_COLS = ["stake", "earning", "mev_rewards", "priority_fee_rewards", "inflationRewards"]

DEFAULT_CSV_PATH = Path(__file__).resolve().parent.parent / "report" / "val_stats2.csv"

# Date <-> epoch mapping: DATE_START is the first day of EPOCH_AT_DATE_START,
# and each epoch spans ~2 days.
DATE_START = date(2026, 6, 3)
DATE_END = date(2026, 7, 2)
EPOCH_AT_DATE_START = 981
EPOCH_AT_DATE_END = 995
DAYS_PER_EPOCH = 2


@st.cache_data
def load_data(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)

    numeric_cols = [
        "mev_commission_bps",
        "mev_rewards",
        "priority_fee_commission_bps",
        "priority_fee_rewards",
        "avg_stake",
        "epoch",
        "inflationRewards",
        "comission",
        "votes",
    ]
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    if "name" not in df.columns:
        df["name"] = ""
    df["name"] = df["name"].fillna("")
    df["client"] = df["client"].fillna("").replace("", "Unknown")

    df["epoch_earning"] = (
        df["mev_rewards"] + df["priority_fee_rewards"] + df["inflationRewards"]
    )

    df["label"] = df.apply(
        lambda r: r["name"] if str(r["name"]).strip() else r["identity_account"],
        axis=1,
    )

    return df


@st.cache_data(ttl=300)
def fetch_sol_usd_price() -> float:
    """Fetch the current SOL/USD price from CoinGecko."""
    url = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    with urlopen(url, timeout=10) as response:
        data = json.load(response)
    return float(data["solana"]["usd"])


def date_range_to_epochs(from_date: date, to_date: date) -> tuple[int, int]:
    """Map a date range onto the epoch range, dropping partially covered epochs.

    The full range (DATE_START..DATE_END) maps to 981..995. Moving the start
    date forward excludes the head epoch as soon as it is only partially
    covered; the end date works the same way in reverse.
    """
    start_offset_days = (from_date - DATE_START).days
    end_offset_days = (DATE_END - to_date).days

    epoch_start = EPOCH_AT_DATE_START + math.ceil(start_offset_days / DAYS_PER_EPOCH)
    epoch_end = EPOCH_AT_DATE_END - math.ceil(end_offset_days / DAYS_PER_EPOCH)
    return epoch_start, epoch_end


def aggregate_epoch_range(df: pd.DataFrame, epoch_start: int, epoch_end: int) -> pd.DataFrame:
    """Collapse per-epoch rows into one row per validator for [epoch_start, epoch_end]."""
    in_range = df[(df["epoch"] >= epoch_start) & (df["epoch"] <= epoch_end)].copy()
    if in_range.empty:
        return in_range

    def first_non_empty(series: pd.Series) -> str:
        for value in series:
            if str(value).strip():
                return str(value)
        return ""

    grouped = (
        in_range.groupby("identity_account", as_index=False)
        .agg(
            name=("name", first_non_empty),
            client=("client", first_non_empty),
            vote_account=("vote_account", "first"),
            earning=("epoch_earning", "sum"),
            mev_rewards=("mev_rewards", "sum"),
            priority_fee_rewards=("priority_fee_rewards", "sum"),
            inflationRewards=("inflationRewards", "sum"),
            stake_sum=("avg_stake", "sum"),
            epochs_in_range=("epoch", "count"),
            votes=("votes", "max"),
            comission=("comission", "max"),
        )
    )

    # Average stake across epochs this validator appears in within the range.
    grouped["stake"] = grouped["stake_sum"] / grouped["epochs_in_range"]
    grouped["label"] = grouped.apply(
        lambda r: r["name"] if str(r["name"]).strip() else r["identity_account"],
        axis=1,
    )

    return grouped.drop(columns=["stake_sum"])


def prepare_table_data(df: pd.DataFrame, sol_usd: float) -> pd.DataFrame:
    """One row per validator: accumulated earning across all available epochs, in SOL."""
    epoch_min = int(df["epoch"].min())
    epoch_max = int(df["epoch"].max())
    accumulated = aggregate_epoch_range(df, epoch_min, epoch_max)

    table = accumulated.copy()
    for col in ["earning", "mev_rewards", "priority_fee_rewards", "inflationRewards", "stake"]:
        table[col] = table[col] / LAMPORTS_PER_SOL

    table["earning_usd"] = table["earning"] * sol_usd

    table = table.rename(
        columns={
            "earning": "accumulated_earning_sol",
            "stake": "avg_stake_sol",
            "mev_rewards": "mev_rewards_sol",
            "priority_fee_rewards": "priority_fee_rewards_sol",
            "inflationRewards": "inflation_rewards_sol",
            "epochs_in_range": "epochs",
        }
    )

    columns = [
        "name",
        "client",
        "identity_account",
        "vote_account",
        "avg_stake_sol",
        "epochs",
        "comission",
        "mev_rewards_sol",
        "priority_fee_rewards_sol",
        "inflation_rewards_sol",
        "accumulated_earning_sol",
        "earning_usd",
    ]
    return table[columns].sort_values("accumulated_earning_sol", ascending=False)


def numeric_range_filter(df: pd.DataFrame, label: str, col: str, fmt: str) -> pd.Series:
    lo, hi = float(df[col].min()), float(df[col].max())
    if lo == hi:
        st.caption(f"{label}: all = {lo:{fmt}}")
        return pd.Series(True, index=df.index)
    selected = st.slider(
        label, min_value=lo, max_value=hi, value=(lo, hi), format=f"%{fmt}"
    )
    return df[col].between(selected[0], selected[1])


def main() -> None:
    st.set_page_config(page_title="Validator Earnings", page_icon="📊", layout="wide")

    with st.sidebar:
        st.header("Data & display")
        csv_path = Path(st.text_input("CSV path", value=str(DEFAULT_CSV_PATH)))
        if not csv_path.exists():
            st.error(f"CSV not found at: {csv_path}")
            st.stop()

        log_x = st.checkbox("Log scale: stake (x)", value=True)
        log_y = st.checkbox("Log scale: earning (y)", value=False)
        agg = st.selectbox(
            "Client aggregation", options=["sum", "mean", "median"], index=0
        )

    raw = load_data(csv_path)

    try:
        sol_usd = fetch_sol_usd_price()
    except (URLError, TimeoutError, KeyError, ValueError) as err:
        st.error(f"Could not fetch SOL/USD price: {err}")
        st.stop()

    st.sidebar.caption(f"SOL/USD: **${sol_usd:,.2f}**")

    st.title("Solana Validator Earnings")
    st.caption(
        "Per-epoch: (mev_rewards + priority_fee_rewards + inflationRewards). "
        "Range totals sum earnings; stake is averaged across epochs in range. "
        "All values in SOL."
    )

    epoch_min = int(raw["epoch"].min())
    epoch_max = int(raw["epoch"].max())

    # ---- Date range -> epoch range ----------------------------------------
    st.subheader("Date range")
    dcol1, dcol2 = st.columns([2, 1])
    with dcol1:
        selected_dates = st.date_input(
            "Period",
            value=(DATE_START, DATE_END),
            min_value=DATE_START,
            max_value=DATE_END,
            help=f"{DATE_START} .. {DATE_END} maps to epochs "
            f"{EPOCH_AT_DATE_START}–{EPOCH_AT_DATE_END} (~{DAYS_PER_EPOCH} days per epoch). "
            "Partially covered epochs are excluded.",
        )

    if isinstance(selected_dates, tuple) and len(selected_dates) == 2:
        from_date, to_date = selected_dates
    else:
        st.info("Select both start and end dates.")
        st.stop()

    if from_date > to_date:
        st.error("Start date must be ≤ end date.")
        st.stop()

    epoch_start, epoch_end = date_range_to_epochs(from_date, to_date)
    epoch_start = max(epoch_start, epoch_min)
    epoch_end = min(epoch_end, epoch_max)

    if epoch_start > epoch_end:
        st.error("The selected date range does not fully cover any epoch.")
        st.stop()

    with dcol2:
        st.metric("Epoch range", f"{epoch_start} – {epoch_end}")

    # ---- Client dropdown ---------------------------------------------------
    all_clients = sorted(raw["client"].unique())
    selected_client = st.selectbox("Client", options=["All clients"] + all_clients)

    aggregated = aggregate_epoch_range(raw, epoch_start, epoch_end)
    if aggregated.empty:
        st.warning(f"No data for epochs {epoch_start}–{epoch_end}.")
        st.stop()

    if selected_client != "All clients":
        aggregated = aggregated[aggregated["client"] == selected_client]
        if aggregated.empty:
            st.warning(f"No validators for client {selected_client} in this range.")
            st.stop()

    st.caption(
        f"Showing {len(aggregated):,} validators aggregated over epochs "
        f"{epoch_start}–{epoch_end} ({epoch_end - epoch_start + 1} epochs)"
        + ("" if selected_client == "All clients" else f" · client: {selected_client}")
    )

    # Everything below is in SOL.
    view = aggregated.copy()
    view[MONETARY_COLS] = view[MONETARY_COLS] / LAMPORTS_PER_SOL

    st.subheader("Filters")
    fcol1, fcol2 = st.columns([3, 1])
    stake_max = float(view["stake"].max())
    with fcol2:
        quick_1m = st.checkbox("Stake ≥ 1,000,000", value=False, help="Quick preset (SOL)")
    with fcol1:
        default_min = 1_000_000.0 if quick_1m else 0.0
        min_stake = st.number_input(
            "Minimum avg stake (SOL)",
            min_value=0.0,
            max_value=stake_max,
            value=min(default_min, stake_max),
            step=max(stake_max / 100, 1.0),
            format="%.2f",
        )

    query = st.text_input(
        "Search", placeholder="Search by validator name or identity…"
    ).strip()

    mask = pd.Series(True, index=view.index)
    mask &= view["stake"] >= min_stake

    if query:
        q = query.lower()
        mask &= (
            view["name"].str.lower().str.contains(q, na=False)
            | view["identity_account"].str.lower().str.contains(q, na=False)
        )

    with st.expander("Per-column filters", expanded=False):
        c1, c2 = st.columns(2)
        with c1:
            mask &= numeric_range_filter(view, "avg stake (SOL)", "stake", ",.2f")
            mask &= numeric_range_filter(view, "votes", "votes", ",.0f")
            mask &= numeric_range_filter(view, "comission (%)", "comission", ",.0f")
            mask &= numeric_range_filter(view, "epochs in range", "epochs_in_range", ",.0f")
        with c2:
            mask &= numeric_range_filter(view, "earning (SOL)", "earning", ",.2f")
            mask &= numeric_range_filter(view, "inflationRewards (SOL)", "inflationRewards", ",.2f")
            mask &= numeric_range_filter(view, "mev_rewards (SOL)", "mev_rewards", ",.2f")
            mask &= numeric_range_filter(
                view, "priority_fee_rewards (SOL)", "priority_fee_rewards", ",.2f"
            )

    df = view[mask]
    if df.empty:
        st.warning("No validators match the current filters.")
        st.stop()

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Validators", f"{len(df):,}")
    col2.metric("Clients", f"{df['client'].nunique():,}")
    col3.metric("Total earning (SOL)", f"{df['earning'].sum():,.2f}")
    col4.metric("Avg earning (SOL)", f"{df['earning'].mean():,.2f}")

    st.subheader("Stake vs. Earning")
    scatter = px.scatter(
        df,
        x="stake",
        y="earning",
        color="client",
        hover_name="label",
        hover_data={
            "name": True,
            "identity_account": True,
            "vote_account": True,
            "epochs_in_range": True,
            "votes": ":,",
            "stake": ":,.2f",
            "earning": ":,.2f",
        },
        labels={
            "stake": "Avg stake (SOL)",
            "earning": "Cumulative earning (SOL)",
        },
        log_x=log_x,
        log_y=log_y,
        height=600,
    )
    scatter.update_traces(marker=dict(size=8, opacity=0.7))
    st.plotly_chart(scatter, use_container_width=True)

    st.subheader("Client vs. Earning")
    grouped = (
        df.groupby("client")["earning"]
        .agg(agg)
        .reset_index()
        .sort_values("earning", ascending=False)
    )
    counts = df.groupby("client").size().rename("validators").reset_index()
    grouped = grouped.merge(counts, on="client")

    bar = px.bar(
        grouped,
        x="client",
        y="earning",
        color="client",
        hover_data={"validators": True, "earning": ":,.2f"},
        labels={
            "earning": f"{agg.capitalize()} earning (SOL)",
            "client": "Client",
        },
        height=500,
    )
    bar.update_layout(showlegend=False, xaxis={"categoryorder": "total descending"})
    st.plotly_chart(bar, use_container_width=True)

    with st.expander("Per-client earning distribution (box plot)"):
        box = px.box(
            df,
            x="client",
            y="earning",
            color="client",
            points="outliers",
            labels={"earning": "Earning (SOL)", "client": "Client"},
            height=500,
        )
        box.update_layout(showlegend=False, xaxis={"categoryorder": "median descending"})
        st.plotly_chart(box, use_container_width=True)

    with st.expander("Show data table", expanded=False):
        table_data = prepare_table_data(raw, sol_usd)
        if selected_client != "All clients":
            table_data = table_data[table_data["client"] == selected_client]
        st.caption(
            f"{len(table_data):,} validators · accumulated earning over epochs "
            f"{epoch_min}–{epoch_max} · values in SOL · earning_usd at ${sol_usd:,.2f}/SOL"
        )
        st.dataframe(table_data, use_container_width=True)


if __name__ == "__main__":
    main()
