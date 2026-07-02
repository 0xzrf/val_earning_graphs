"""Interactive dashboard for Solana validator earnings (Jito / val_stats2).

Reads ../report/val_stats2.csv (one row per validator per epoch) and visualizes:
  1. Stake vs. Earning   (scatter)
  2. Client vs. Earning   (aggregated bar + per-client distribution)

Per-epoch earning:
    (mev_rewards + priority_fee_rewards + inflationRewards) − (votes × 5000)

Range earning (epochs Ea..Eb inclusive) is the sum of per-epoch earnings.
Range stake is the average avg_stake across epochs present in the range.

Run with:
    streamlit run frontend/app.py
"""

from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

LAMPORTS_PER_SOL = 1_000_000_000
VOTE_FEE_LAMPORTS = 5_000

MONETARY_COLS = ["stake", "earning", "mev_rewards", "priority_fee_rewards", "inflationRewards"]

DEFAULT_CSV_PATH = Path(__file__).resolve().parent.parent / "report" / "val_stats2.csv"
DEFAULT_EPOCH_START = 981
DEFAULT_EPOCH_END = 995


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
        df["mev_rewards"]
        + df["priority_fee_rewards"]
        + df["inflationRewards"]
        - df["votes"] * VOTE_FEE_LAMPORTS
    )

    df["label"] = df.apply(
        lambda r: r["name"] if str(r["name"]).strip() else r["identity_account"],
        axis=1,
    )

    return df


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
    st.title("Solana Validator Earnings")
    st.caption(
        "Per-epoch: (mev_rewards + priority_fee_rewards + inflationRewards) − (votes × 5000). "
        "Range totals sum earnings; stake is averaged across epochs in range."
    )

    with st.sidebar:
        st.header("Data & display")
        csv_path = Path(st.text_input("CSV path", value=str(DEFAULT_CSV_PATH)))
        if not csv_path.exists():
            st.error(f"CSV not found at: {csv_path}")
            st.stop()

        unit = st.radio("Units", options=["SOL", "lamports"], index=0, horizontal=True)
        log_x = st.checkbox("Log scale: stake (x)", value=True)
        log_y = st.checkbox("Log scale: earning (y)", value=False)
        agg = st.selectbox(
            "Client aggregation", options=["sum", "mean", "median"], index=0
        )

    raw = load_data(csv_path)
    epoch_min = int(raw["epoch"].min())
    epoch_max = int(raw["epoch"].max())

    st.subheader("Epoch range")
    ecol1, ecol2 = st.columns(2)
    with ecol1:
        epoch_start = st.number_input(
            "From epoch (Ea)",
            min_value=epoch_min,
            max_value=epoch_max,
            value=min(DEFAULT_EPOCH_START, epoch_max),
            step=1,
        )
    with ecol2:
        epoch_end = st.number_input(
            "To epoch (Eb)",
            min_value=epoch_min,
            max_value=epoch_max,
            value=min(DEFAULT_EPOCH_END, epoch_max),
            step=1,
        )

    if epoch_start > epoch_end:
        st.error("From epoch must be ≤ to epoch.")
        st.stop()

    aggregated = aggregate_epoch_range(raw, int(epoch_start), int(epoch_end))
    if aggregated.empty:
        st.warning(f"No data for epochs {epoch_start}–{epoch_end}.")
        st.stop()

    st.caption(
        f"Showing {len(aggregated):,} validators aggregated over epochs "
        f"{epoch_start}–{epoch_end} ({epoch_end - epoch_start + 1} epochs)."
    )

    unit_label = unit
    view = aggregated.copy()
    if unit == "SOL":
        view[MONETARY_COLS] = view[MONETARY_COLS] / LAMPORTS_PER_SOL

    st.subheader("Filters")
    fcol1, fcol2 = st.columns([3, 1])
    stake_max = float(view["stake"].max())
    with fcol2:
        quick_1m = st.checkbox("Stake ≥ 1,000,000", value=False, help="Quick preset (SOL)")
    with fcol1:
        default_min = 1_000_000.0 if quick_1m and unit == "SOL" else 0.0
        min_stake = st.number_input(
            f"Minimum avg stake ({unit_label})",
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
        clients = sorted(view["client"].unique())
        selected_clients = st.multiselect("client", options=clients, default=clients)
        mask &= view["client"].isin(selected_clients)

        c1, c2 = st.columns(2)
        with c1:
            mask &= numeric_range_filter(view, f"avg stake ({unit_label})", "stake", ",.2f")
            mask &= numeric_range_filter(view, "votes", "votes", ",.0f")
            mask &= numeric_range_filter(view, "comission (%)", "comission", ",.0f")
            mask &= numeric_range_filter(view, "epochs in range", "epochs_in_range", ",.0f")
        with c2:
            mask &= numeric_range_filter(view, f"earning ({unit_label})", "earning", ",.2f")
            mask &= numeric_range_filter(
                view, f"inflationRewards ({unit_label})", "inflationRewards", ",.2f"
            )
            mask &= numeric_range_filter(view, f"mev_rewards ({unit_label})", "mev_rewards", ",.2f")
            mask &= numeric_range_filter(
                view, f"priority_fee_rewards ({unit_label})", "priority_fee_rewards", ",.2f"
            )

    df = view[mask]
    if df.empty:
        st.warning("No validators match the current filters.")
        st.stop()

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Validators", f"{len(df):,}")
    col2.metric("Clients", f"{df['client'].nunique():,}")
    col3.metric(f"Total earning ({unit_label})", f"{df['earning'].sum():,.2f}")
    col4.metric(f"Avg earning ({unit_label})", f"{df['earning'].mean():,.2f}")

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
            "stake": f"Avg stake ({unit_label})",
            "earning": f"Cumulative earning ({unit_label})",
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
            "earning": f"{agg.capitalize()} earning ({unit_label})",
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
            labels={"earning": f"Earning ({unit_label})", "client": "Client"},
            height=500,
        )
        box.update_layout(showlegend=False, xaxis={"categoryorder": "median descending"})
        st.plotly_chart(box, use_container_width=True)

    with st.expander("Show data table", expanded=False):
        st.dataframe(
            df[
                [
                    "name",
                    "identity_account",
                    "client",
                    "stake",
                    "epochs_in_range",
                    "votes",
                    "comission",
                    "earning",
                ]
            ].sort_values("earning", ascending=False),
            use_container_width=True,
        )


if __name__ == "__main__":
    main()
