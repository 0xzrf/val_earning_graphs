"""Interactive dashboard for Solana validator earnings.

Reads ../report/val_stats.csv and visualizes:
  1. Stake vs. Earning   (scatter)
  2. Client vs. Earning   (aggregated bar + per-client distribution)

Earning is defined as:
    (blocks * (avgFees + avgTip) + inflationRewards) - (votes * 5000)

Run with:
    streamlit run frontend/app.py
"""

from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

LAMPORTS_PER_SOL = 1_000_000_000
VOTE_FEE_LAMPORTS = 5_000

# Monetary columns are stored in lamports and converted to the chosen unit.
MONETARY_COLS = ["stake", "avgFees", "avgTip", "inflationRewards", "earning"]

# val_stats.csv lives in ../report relative to this file.
DEFAULT_CSV_PATH = Path(__file__).resolve().parent.parent / "report" / "val_stats.csv"


@st.cache_data
def load_data(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)

    numeric_cols = [
        "blocks",
        "avgFees",
        "avgTip",
        "stake",
        "comission",
        "votes",
        "inflationRewards",
    ]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    if "name" not in df.columns:
        df["name"] = ""
    df["name"] = df["name"].fillna("")
    df["client"] = df["client"].fillna("").replace("", "Unknown")

    # Earning in lamports.
    df["earning"] = (
        df["blocks"] * (df["avgFees"] + df["avgTip"])
        + df["inflationRewards"]
        - df["votes"] * VOTE_FEE_LAMPORTS
    )

    # A human label: validator name when present, otherwise the identity.
    df["label"] = df.apply(
        lambda r: r["name"] if str(r["name"]).strip() else r["identity"], axis=1
    )

    return df


def numeric_range_filter(df: pd.DataFrame, label: str, col: str, fmt: str) -> pd.Series:
    """Render a range slider for a numeric column and return a boolean mask."""
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
        "Earning = (blocks × (avgFees + avgTip) + inflationRewards) − (votes × 5000)"
    )

    # ---- Sidebar: data + display -----------------------------------------
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

    unit_label = unit
    raw = load_data(csv_path)

    # Convert monetary columns into the chosen unit on a working copy.
    view = raw.copy()
    if unit == "SOL":
        view[MONETARY_COLS] = view[MONETARY_COLS] / LAMPORTS_PER_SOL

    # ---- Top filter: minimum stake ---------------------------------------
    st.subheader("Filters")
    fcol1, fcol2 = st.columns([3, 1])
    stake_max = float(view["stake"].max())
    with fcol2:
        quick_1m = st.checkbox("Stake ≥ 1,000,000", value=False, help="Quick preset")
    with fcol1:
        default_min = 1_000_000.0 if quick_1m else 0.0
        min_stake = st.number_input(
            f"Minimum stake ({unit_label})",
            min_value=0.0,
            max_value=stake_max,
            value=min(default_min, stake_max),
            step=max(stake_max / 100, 1.0),
            format="%.2f",
        )

    # ---- Search bar -------------------------------------------------------
    query = st.text_input(
        "Search", placeholder="Search by validator name or identity…"
    ).strip()

    # ---- Per-column filters ----------------------------------------------
    mask = pd.Series(True, index=view.index)
    mask &= view["stake"] >= min_stake

    if query:
        q = query.lower()
        mask &= (
            view["name"].str.lower().str.contains(q, na=False)
            | view["identity"].str.lower().str.contains(q, na=False)
        )

    with st.expander("Per-column filters", expanded=False):
        clients = sorted(view["client"].unique())
        selected_clients = st.multiselect("client", options=clients, default=clients)
        mask &= view["client"].isin(selected_clients)

        c1, c2 = st.columns(2)
        with c1:
            mask &= numeric_range_filter(view, f"stake ({unit_label})", "stake", ",.2f")
            mask &= numeric_range_filter(view, "blocks", "blocks", ",.0f")
            mask &= numeric_range_filter(view, "votes", "votes", ",.0f")
            mask &= numeric_range_filter(view, "comission (%)", "comission", ",.0f")
        with c2:
            mask &= numeric_range_filter(view, f"earning ({unit_label})", "earning", ",.2f")
            mask &= numeric_range_filter(
                view, f"inflationRewards ({unit_label})", "inflationRewards", ",.2f"
            )
            mask &= numeric_range_filter(view, f"avgFees ({unit_label})", "avgFees", ",.2f")
            mask &= numeric_range_filter(view, f"avgTip ({unit_label})", "avgTip", ",.2f")

    df = view[mask]
    if df.empty:
        st.warning("No validators match the current filters.")
        st.stop()

    # ---- Summary metrics --------------------------------------------------
    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Validators", f"{len(df):,}")
    col2.metric("Clients", f"{df['client'].nunique():,}")
    col3.metric(f"Total earning ({unit_label})", f"{df['earning'].sum():,.2f}")
    col4.metric(f"Avg earning ({unit_label})", f"{df['earning'].mean():,.2f}")

    # ---- Chart 1: Stake vs Earning ---------------------------------------
    st.subheader("Stake vs. Earning")
    scatter = px.scatter(
        df,
        x="stake",
        y="earning",
        color="client",
        hover_name="label",
        hover_data={
            "name": True,
            "identity": True,
            "voteAccount": True,
            "blocks": ":,",
            "votes": ":,",
            "stake": ":,.2f",
            "earning": ":,.2f",
        },
        labels={
            "stake": f"Stake ({unit_label})",
            "earning": f"Earning ({unit_label})",
        },
        log_x=log_x,
        log_y=log_y,
        height=600,
    )
    scatter.update_traces(marker=dict(size=8, opacity=0.7))
    st.plotly_chart(scatter, use_container_width=True)

    # ---- Chart 2: Client vs Earning --------------------------------------
    st.subheader("Client vs. Earning")
    grouped = (
        df.groupby("client")["earning"].agg(agg).reset_index().sort_values(
            "earning", ascending=False
        )
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

    # ---- Raw data ---------------------------------------------------------
    with st.expander("Show data table", expanded=False):
        st.dataframe(
            df[
                [
                    "name",
                    "identity",
                    "client",
                    "stake",
                    "blocks",
                    "votes",
                    "comission",
                    "inflationRewards",
                    "earning",
                ]
            ].sort_values("earning", ascending=False),
            use_container_width=True,
        )


if __name__ == "__main__":
    main()
