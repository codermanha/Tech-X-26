"""Hospital Capacity ROI Simulator.

Quantifies bed-hours unlocked, virtual bed capacity added, ED boarding reduction,
and annual financial value from cutting post-clearance discharge delays.
"""


def calculate_hospital_roi(
    daily_discharges: int = 45,
    baseline_delay_hours: float = 8.0,
    orchestrated_delay_hours: float = 2.5,
    bed_hour_value_usd: float = 145.0,
    baseline_ed_boarding_hours: float = 6.5,
) -> dict:
    """Compute operational and financial ROI metrics."""
    hours_saved_per_patient = max(0.0, baseline_delay_hours - orchestrated_delay_hours)
    daily_bed_hours_unlocked = round(daily_discharges * hours_saved_per_patient, 1)
    annual_bed_hours_unlocked = round(daily_bed_hours_unlocked * 365, 0)

    # 1 physical hospital bed at 85% target occupancy provides 365 * 24 * 0.85 = 7,446 bed-hours/year
    equivalent_beds_added = round(annual_bed_hours_unlocked / 7446.0, 1)

    delay_reduction_ratio = (
        hours_saved_per_patient / baseline_delay_hours if baseline_delay_hours > 0 else 0.0
    )
    # Upstream inpatient turnover directly compresses ED boarding wait times (~70% pass-through)
    ed_boarding_reduction_pct = round(min(delay_reduction_ratio * 70.0, 65.0), 1)
    new_ed_boarding_hours = round(
        baseline_ed_boarding_hours * (1.0 - ed_boarding_reduction_pct / 100.0), 1
    )

    annual_financial_impact_usd = round(annual_bed_hours_unlocked * bed_hour_value_usd, 0)

    return {
        "hours_saved_per_patient": round(hours_saved_per_patient, 1),
        "daily_bed_hours_unlocked": daily_bed_hours_unlocked,
        "annual_bed_hours_unlocked": int(annual_bed_hours_unlocked),
        "equivalent_beds_added": equivalent_beds_added,
        "ed_boarding_reduction_pct": ed_boarding_reduction_pct,
        "new_ed_boarding_hours": new_ed_boarding_hours,
        "annual_financial_impact_usd": int(annual_financial_impact_usd),
    }
