import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { Exam } from '@evalnexa/types';

interface Preset {
  name: string;
  badge: string;
  scripts: number;
  examiners: number;
  pace: number;
  moderators: number;
  modSamplePct: number;
  modPace: number;
  workDaysPerWeek: number;
}

const PRESETS: Preset[] = [
  {
    name: 'Midterm Tripos',
    badge: 'Standard',
    scripts: 2400,
    examiners: 12,
    pace: 20,
    moderators: 2,
    modSamplePct: 10,
    modPace: 25,
    workDaysPerWeek: 5,
  },
  {
    name: 'University Final Board',
    badge: 'High Stakes',
    scripts: 8500,
    examiners: 30,
    pace: 22,
    moderators: 4,
    modSamplePct: 15,
    modPace: 30,
    workDaysPerWeek: 6,
  },
  {
    name: 'High-Volume Foundation',
    badge: 'Mega Scale',
    scripts: 18000,
    examiners: 45,
    pace: 25,
    moderators: 5,
    modSamplePct: 10,
    modPace: 35,
    workDaysPerWeek: 6,
  },
];

type ActiveTab = 'gantt' | 'curve' | 'diagnostics';

export function TimelineSimulatorPage() {
  // Simulator Core Inputs
  const [totalScripts, setTotalScripts] = useState<number>(5000);
  const [activeExaminers, setActiveExaminers] = useState<number>(20);
  const [evalPace, setEvalPace] = useState<number>(25); // scripts/examiner/day
  const [activeModerators, setActiveModerators] = useState<number>(3);
  const [modSamplePct, setModSamplePct] = useState<number>(10); // % of scripts sampled
  const [modPace, setModPace] = useState<number>(30); // scripts/moderator/day
  const [workDaysPerWeek, setWorkDaysPerWeek] = useState<number>(6); // 5 or 6
  const [startDateStr, setStartDateStr] = useState<string>(
    new Date().toISOString().split('T')[0]
  );

  // Interactive Playback Engine State
  const [simulatedDay, setSimulatedDay] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [activeTab, setActiveTab] = useState<ActiveTab>('gantt');
  const [copiedMemo, setCopiedMemo] = useState(false);
  const [chartHoverDay, setChartHoverDay] = useState<number | null>(null);

  // Optional: load real examination scope
  const { data: examsData } = useQuery<{ success: boolean; data: Exam[] }>({
    queryKey: ['exams-list'],
    queryFn: async () => {
      const res = await apiClient.get('/exams');
      return res.data;
    },
  });

  const exams = examsData?.data || [];

  // ==========================================
  // MATHEMATICAL CALCULATION ENGINE
  // ==========================================
  const simulation = useMemo(() => {
    const scripts = Math.max(1, totalScripts);
    const examiners = Math.max(1, activeExaminers);
    const pace = Math.max(1, evalPace);
    const moderators = Math.max(1, activeModerators);
    const modPct = Math.max(1, Math.min(100, modSamplePct));
    const mPace = Math.max(1, modPace);

    // 1. Evaluation Phase
    const dailyEvalCapacity = examiners * pace;
    const evalWorkingDays = Math.ceil(scripts / dailyEvalCapacity);
    const scriptsPerExaminer = Math.round(scripts / examiners);

    // 2. Moderation Phase
    const modScriptsTotal = Math.ceil((scripts * modPct) / 100);
    const dailyModCapacity = moderators * mPace;
    const modWorkingDays = Math.ceil(modScriptsTotal / dailyModCapacity);

    // Incoming moderation demand per day
    const dailyModIncoming = Math.ceil((dailyEvalCapacity * modPct) / 100);
    const modCapacityRatio = dailyModCapacity / Math.max(1, dailyModIncoming);

    // 3. Overall Pipeline Duration
    let totalWorkingDays = evalWorkingDays + 1; // 1 day final audit/gazetting
    let bottleneckType: 'EVALUATION' | 'MODERATION' | 'EXAMINER_LOAD' | 'BALANCED' = 'BALANCED';
    let bottleneckTitle = 'Pipeline Synchronized';
    let bottleneckDesc = 'Examiner marking throughput matches moderation review velocity. Smooth delivery projected.';
    let bottleneckSeverity: 'emerald' | 'amber' | 'crimson' = 'emerald';

    if (modCapacityRatio < 0.95) {
      const modBacklogLagDays = Math.ceil(modScriptsTotal / dailyModCapacity) - evalWorkingDays;
      if (modBacklogLagDays > 0) {
        totalWorkingDays = evalWorkingDays + modBacklogLagDays + 1;
      }
      bottleneckType = 'MODERATION';
      bottleneckSeverity = modCapacityRatio < 0.7 ? 'crimson' : 'amber';
      bottleneckTitle = `Moderation Deficit (${Math.round((1 - modCapacityRatio) * 100)}% Under-Capacity)`;
      bottleneckDesc = `Examiners yield ~${dailyModIncoming} audited scripts/day, but ${moderators} moderators only clear ${dailyModCapacity}/day. Review queues will clog.`;
    } else if (evalWorkingDays > 22) {
      bottleneckType = 'EVALUATION';
      bottleneckSeverity = evalWorkingDays > 32 ? 'crimson' : 'amber';
      bottleneckTitle = `Extended Evaluation Window (${evalWorkingDays} Working Days)`;
      bottleneckDesc = `Evaluation timeline is stretched. Expanding examiner pool from ${examiners} to ${examiners + 6} would cut delivery by ${Math.max(1, evalWorkingDays - Math.ceil(scripts / ((examiners + 6) * pace)))} days.`;
    } else if (pace > 34) {
      bottleneckType = 'EXAMINER_LOAD';
      bottleneckSeverity = 'amber';
      bottleneckTitle = `Aggressive Examiner Pace (${pace} scripts/day)`;
      bottleneckDesc = `Pace exceeds optimal cognitive threshold (30 scripts/day). Elevates risk of marking variance and student appeals.`;
    }

    // 4. Calendar Date Calculation (skipping weekend days)
    const startDate = new Date(startDateStr);
    let curr = new Date(startDate);
    let daysCounted = 0;

    const dayByDayCalendar: { dayIndex: number; dateFormatted: string; isWorkDay: boolean }[] = [];
    while (daysCounted < totalWorkingDays) {
      curr.setDate(curr.getDate() + 1);
      const dayOfWeek = curr.getDay(); // 0 Sun, 6 Sat
      const isWorkDay = workDaysPerWeek === 6 ? dayOfWeek !== 0 : dayOfWeek !== 0 && dayOfWeek !== 6;
      if (isWorkDay) {
        daysCounted++;
        dayByDayCalendar.push({
          dayIndex: daysCounted,
          dateFormatted: curr.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
          isWorkDay: true,
        });
      }
    }

    const completionDateFormatted = curr.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    // 5. Daily Curve Generation for SVG Visualization
    const curvePoints: {
      day: number;
      dateStr: string;
      cumulativeMarked: number;
      cumulativeModerated: number;
      backlog: number;
    }[] = [];

    let cumMarked = 0;
    let cumModerated = 0;

    for (let d = 1; d <= totalWorkingDays; d++) {
      cumMarked = Math.min(scripts, cumMarked + dailyEvalCapacity);
      // Moderation kicks off from day 2
      if (d >= 2) {
        const targetSampledSoFar = Math.ceil((cumMarked * modPct) / 100);
        const maxModPossible = (d - 1) * dailyModCapacity;
        cumModerated = Math.min(modScriptsTotal, Math.min(targetSampledSoFar, maxModPossible));
      }

      const incomingModDemandSoFar = Math.ceil((cumMarked * modPct) / 100);
      const backlog = Math.max(0, incomingModDemandSoFar - cumModerated);

      curvePoints.push({
        day: d,
        dateStr: dayByDayCalendar[d - 1]?.dateFormatted || `Day ${d}`,
        cumulativeMarked: cumMarked,
        cumulativeModerated: cumModerated,
        backlog,
      });
    }

    // 6. Sensitivity / What-If Scenarios
    const whatIfAddExaminers = Math.ceil(scripts / ((examiners + 5) * pace));
    const daysSavedWithExaminers = Math.max(0, evalWorkingDays - whatIfAddExaminers);

    const whatIfPaceDown = Math.ceil(scripts / (examiners * Math.max(5, pace - 5)));
    const daysLostWithPaceDrop = whatIfPaceDown - evalWorkingDays;

    // Fatigue & Appeal Risk Index (0-100)
    const examinerFatigueScore = Math.min(100, Math.round((pace / 40) * 80 + (evalWorkingDays > 20 ? 20 : 5)));
    const appealRiskScore = Math.min(100, Math.round((pace > 30 ? (pace - 30) * 3 : 0) + (modPct < 10 ? (10 - modPct) * 4 : 0) + 12));

    return {
      dailyEvalCapacity,
      evalWorkingDays,
      scriptsPerExaminer,
      modScriptsTotal,
      dailyModCapacity,
      modWorkingDays,
      dailyModIncoming,
      modCapacityRatio,
      totalWorkingDays,
      bottleneckType,
      bottleneckTitle,
      bottleneckDesc,
      bottleneckSeverity,
      completionDateFormatted,
      calendarDays: Math.ceil((curr.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)),
      curvePoints,
      examinerFatigueScore,
      appealRiskScore,
      whatIf: {
        daysSavedWithExaminers,
        daysLostWithPaceDrop,
      },
    };
  }, [totalScripts, activeExaminers, evalPace, activeModerators, modSamplePct, modPace, workDaysPerWeek, startDateStr]);

  // Ensure simulatedDay stays within 0..totalWorkingDays
  useEffect(() => {
    if (simulatedDay > simulation.totalWorkingDays) {
      setSimulatedDay(simulation.totalWorkingDays);
    }
  }, [simulation.totalWorkingDays, simulatedDay]);

  // Interactive Playhead Timer
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (isPlaying) {
      const intervalMs = Math.max(120, 600 / playbackSpeed);
      timerRef.current = window.setInterval(() => {
        setSimulatedDay((prev) => {
          if (prev >= simulation.totalWorkingDays) {
            setIsPlaying(false);
            return simulation.totalWorkingDays;
          }
          return prev + 1;
        });
      }, intervalMs);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPlaying, playbackSpeed, simulation.totalWorkingDays]);

  // Current Live Scrubber Metrics at simulatedDay
  const liveMetrics = useMemo(() => {
    const day = simulatedDay;
    if (day === 0) {
      return {
        marked: 0,
        pendingMarking: totalScripts,
        moderated: 0,
        pendingModeration: simulation.modScriptsTotal,
        pctMarked: 0,
        pctModerated: 0,
        isCompleted: false,
        stageName: 'Docket Ingestion & Registration',
        stageColor: 'var(--sim-accent-primary)',
      };
    }

    const curvePoint = simulation.curvePoints[day - 1];
    const marked = curvePoint ? curvePoint.cumulativeMarked : totalScripts;
    const moderated = curvePoint ? curvePoint.cumulativeModerated : simulation.modScriptsTotal;
    const pctMarked = Math.round((marked / totalScripts) * 100);
    const pctModerated = Math.round((moderated / Math.max(1, simulation.modScriptsTotal)) * 100);
    const isCompleted = day >= simulation.totalWorkingDays;

    let stageName = '1. Primary Script Marking Phase';
    let stageColor = 'var(--sim-accent-primary)';

    if (isCompleted) {
      stageName = '3. Official Audit & Result Gazetting (Complete)';
      stageColor = 'var(--sim-accent-emerald)';
    } else if (day >= simulation.evalWorkingDays) {
      stageName = '2. Moderation Verification & Closeout';
      stageColor = 'var(--sim-accent-secondary)';
    }

    return {
      marked,
      pendingMarking: Math.max(0, totalScripts - marked),
      moderated,
      pendingModeration: Math.max(0, simulation.modScriptsTotal - moderated),
      pctMarked,
      pctModerated,
      isCompleted,
      stageName,
      stageColor,
    };
  }, [simulatedDay, totalScripts, simulation]);

  const handleApplyPreset = (p: Preset) => {
    setTotalScripts(p.scripts);
    setActiveExaminers(p.examiners);
    setEvalPace(p.pace);
    setActiveModerators(p.moderators);
    setModSamplePct(p.modSamplePct);
    setModPace(p.modPace);
    setWorkDaysPerWeek(p.workDaysPerWeek);
    setSimulatedDay(0);
    setIsPlaying(false);
  };

  const handleCopyMemo = () => {
    const text = `EVALNEXA DOCKET // TIMELINE SIMULATION REPORT
--------------------------------------------------
Total Scripts: ${totalScripts.toLocaleString()}
Examiners: ${activeExaminers} @ ${evalPace} scripts/day (Daily Throughput: ${simulation.dailyEvalCapacity} scripts/day)
Moderators: ${activeModerators} (${modSamplePct}% sample @ ${modPace}/day)
Working Days: ${simulation.totalWorkingDays} days (${workDaysPerWeek}-day working week)
Projected Gazetting Date: ${simulation.completionDateFormatted}
Identified Bottleneck: ${simulation.bottleneckTitle}
Examiner Cognitive Load Score: ${simulation.examinerFatigueScore}/100
Moderation Capacity Ratio: ${Math.round(simulation.modCapacityRatio * 100)}%
--------------------------------------------------
Generated by EvalNexa Predictive Engine on ${new Date().toLocaleDateString()}`;

    navigator.clipboard.writeText(text);
    setCopiedMemo(true);
    setTimeout(() => setCopiedMemo(false), 2500);
  };

  return (
    <div className="evalnexa-sim-wrapper" style={{ maxWidth: 1320, margin: '0 auto', paddingBottom: 'var(--space-8)' }}>
      {/* Dynamic Theme Styles for Simulator */}
      <style>{`
        :root {
          --sim-bg: #FCFAF6;
          --sim-card-bg: #FFFFFF;
          --sim-card-border: #D6CCA8;
          --sim-rule: #CFC5B2;
          --sim-accent-primary: #0E1A2B;
          --sim-accent-secondary: #9E7A38;
          --sim-accent-tertiary: #5C1D24;
          --sim-accent-emerald: #15803D;
          --sim-accent-amber: #B45309;
          --sim-accent-crimson: #991B1B;
          --sim-track-bg: #EFE7DA;
          --sim-pipeline-node: #F7F3EB;
          --sim-glow: 0 4px 18px rgba(158, 122, 56, 0.12);
          --sim-pulse: rgba(14, 26, 43, 0.15);
          --sim-badge-bg: #EAE3D2;
          --sim-text-main: #17181C;
          --sim-text-sub: #4A4A55;
          --sim-svg-grid: #E8E0D2;
          --sim-svg-target: #7B1113;
          --sim-svg-eval-line: #0E1A2B;
          --sim-svg-mod-line: #9E7A38;
          --sim-svg-eval-fill: rgba(14, 26, 43, 0.12);
          --sim-svg-mod-fill: rgba(158, 122, 56, 0.18);
        }

        [data-theme="dark"] {
          --sim-bg: #0A0E17;
          --sim-card-bg: #121927;
          --sim-card-border: rgba(56, 189, 248, 0.22);
          --sim-rule: rgba(255, 255, 255, 0.10);
          --sim-accent-primary: #38BDF8;
          --sim-accent-secondary: #F59E0B;
          --sim-accent-tertiary: #A78BFA;
          --sim-accent-emerald: #10B981;
          --sim-accent-amber: #FBBF24;
          --sim-accent-crimson: #FB7185;
          --sim-track-bg: #182236;
          --sim-pipeline-node: #162035;
          --sim-glow: 0 0 24px rgba(56, 189, 248, 0.22);
          --sim-pulse: rgba(56, 189, 248, 0.35);
          --sim-badge-bg: #1E293B;
          --sim-text-main: #F8FAFC;
          --sim-text-sub: #94A3B8;
          --sim-svg-grid: rgba(255, 255, 255, 0.08);
          --sim-svg-target: #FB7185;
          --sim-svg-eval-line: #38BDF8;
          --sim-svg-mod-line: #F59E0B;
          --sim-svg-eval-fill: rgba(56, 189, 248, 0.2);
          --sim-svg-mod-fill: rgba(245, 158, 11, 0.2);
        }

        /* Pulse animations for active simulation flow */
        @keyframes simPulseConduit {
          0% { stroke-dashoffset: 24; }
          100% { stroke-dashoffset: 0; }
        }

        .sim-active-conduit {
          stroke-dasharray: 6 6;
          animation: simPulseConduit 1.2s linear infinite;
        }

        .sim-range-input {
          -webkit-appearance: none;
          appearance: none;
          height: 6px;
          border-radius: 3px;
          background: var(--sim-track-bg);
          outline: none;
          transition: background-color var(--ease-ink);
        }
        .sim-range-input::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--sim-accent-primary);
          border: 2px solid var(--sim-card-bg);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
          cursor: pointer;
          transition: box-shadow var(--ease-ink), background-color var(--ease-ink), border-color var(--ease-ink);
        }
        .sim-range-input::-webkit-slider-thumb:hover {
          box-shadow: 0 0 0 4px var(--sim-pulse), 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        .sim-range-input::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--sim-accent-primary);
          border: 2px solid var(--sim-card-bg);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
          cursor: pointer;
          transition: box-shadow var(--ease-ink), background-color var(--ease-ink);
        }
        .sim-range-input::-moz-range-thumb:hover {
          box-shadow: 0 0 0 4px var(--sim-pulse);
        }

        .sim-tab-btn {
          padding: 8px 16px;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.05em;
          border: 1px solid var(--sim-rule);
          background: var(--sim-card-bg);
          color: var(--sim-text-sub);
          cursor: pointer;
          transition: background-color var(--ease-snap), color var(--ease-snap), border-color var(--ease-snap), box-shadow var(--ease-snap);
        }
        .sim-tab-btn:active {
          transform: scale(0.985);
        }
        .sim-tab-btn.active {
          background: var(--sim-accent-primary);
          color: #FFFFFF;
          border-color: var(--sim-accent-primary);
          box-shadow: var(--sim-glow);
        }
        [data-theme="dark"] .sim-tab-btn.active {
          color: #0A0E17;
          font-weight: 700;
        }

        .sim-interactive-lever {
          transition: border-color var(--ease-ink), background-color var(--ease-ink), box-shadow var(--ease-ink), transform var(--ease-tactile);
          cursor: pointer;
          border-left: 3px solid transparent;
        }
        .sim-interactive-lever:hover {
          border-color: var(--sim-accent-secondary) !important;
          box-shadow: var(--sim-glow);
          border-left-color: var(--sim-accent-secondary) !important;
        }
        .sim-interactive-lever:active {
          transform: scale(0.988);
        }
      `}</style>

      {/* Editorial Header */}
      <div className="page-header" style={{ marginBottom: 'var(--space-6)' }}>
        <div>
          <div className="page-header__eyebrow" style={{ color: 'var(--sim-accent-secondary)', letterSpacing: '0.16em' }}>
            EVALNEXA ARCHIVAL DOCKET // PREDICTIVE CADENCE ENGINE
          </div>
          <h1 className="page-header__title" style={{ color: 'var(--sim-text-main)' }}>
            Examination Timeline <em>Simulator.</em>
          </h1>
          <p className="page-header__subtitle" style={{ color: 'var(--sim-text-sub)' }}>
            Simulate operational throughput across script registration, marking capacity, and moderation queues. Detect pipeline bottlenecks and forecast completion dates.
          </p>
        </div>

        {/* Preset Selector */}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-4)' }}>
          {PRESETS.map((p) => {
            const isCurrent =
              totalScripts === p.scripts &&
              activeExaminers === p.examiners &&
              evalPace === p.pace;
            return (
              <button
                key={p.name}
                type="button"
                className="sim-tab-btn"
                style={{
                  borderRadius: '4px',
                  background: isCurrent ? 'var(--sim-accent-primary)' : 'var(--sim-card-bg)',
                  color: isCurrent ? (document.documentElement.getAttribute('data-theme') === 'dark' ? '#0A0E17' : '#FFFFFF') : 'var(--sim-text-main)',
                  borderColor: isCurrent ? 'var(--sim-accent-primary)' : 'var(--sim-card-border)',
                }}
                onClick={() => handleApplyPreset(p)}
              >
                <span>{p.name}</span>
                <span style={{ marginLeft: 6, fontSize: '10px', opacity: 0.8, textTransform: 'uppercase' }}>
                  ({p.badge})
                </span>
              </button>
            );
          })}
          {exams.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '11px', padding: '6px 14px' }}
              onClick={() => {
                setTotalScripts(exams[0].totalQuestions ? exams[0].totalQuestions * 150 : 3500);
                setSimulatedDay(0);
              }}
            >
              📥 Load Live Exam Scope ({exams[0].title.slice(0, 20)}...)
            </button>
          )}
        </div>
      </div>

      {/* TOP PREDICTIVE EXECUTIVE SUMMARY BANNER */}
      <div
        className="folio-card"
        style={{
          marginBottom: 'var(--space-6)',
          background: 'var(--sim-card-bg)',
          borderColor: 'var(--sim-card-border)',
          borderLeft: `5px solid ${
            simulation.bottleneckSeverity === 'crimson'
              ? 'var(--sim-accent-crimson)'
              : simulation.bottleneckSeverity === 'amber'
              ? 'var(--sim-accent-amber)'
              : 'var(--sim-accent-emerald)'
          }`,
          boxShadow: 'var(--sim-glow)',
        }}
      >
        <div className="folio-card__body" style={{ padding: 'var(--space-6)' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 'var(--space-6)',
              alignItems: 'center',
            }}
          >
            {/* Projected Date */}
            <div>
              <div className="label-caps" style={{ color: 'var(--sim-accent-secondary)', letterSpacing: '0.14em', marginBottom: 4 }}>
                PROJECTED COMPLETION FOLIO
              </div>
              <div
                style={{
                  fontSize: '25px',
                  fontWeight: 700,
                  color: 'var(--sim-text-main)',
                  lineHeight: 1.15,
                  fontFamily: 'var(--font-serif)',
                }}
              >
                {simulation.completionDateFormatted}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--sim-text-sub)', marginTop: 4 }}>
                <strong style={{ color: 'var(--sim-accent-primary)' }}>{simulation.totalWorkingDays}</strong> Working Days · {simulation.calendarDays} Calendar Days
              </div>
            </div>

            {/* Identified Bottleneck */}
            <div style={{ borderLeft: '1px solid var(--sim-rule)', paddingLeft: 'var(--space-5)' }}>
              <div className="label-caps" style={{ color: 'var(--sim-accent-secondary)', letterSpacing: '0.14em', marginBottom: 4 }}>
                PIPELINE DIAGNOSTIC STATE
              </div>
              <div
                style={{
                  fontSize: '16px',
                  fontWeight: 700,
                  color:
                    simulation.bottleneckSeverity === 'crimson'
                      ? 'var(--sim-accent-crimson)'
                      : simulation.bottleneckSeverity === 'amber'
                      ? 'var(--sim-accent-amber)'
                      : 'var(--sim-accent-emerald)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>{simulation.bottleneckSeverity === 'emerald' ? '✓' : '⚠'}</span>
                <span>{simulation.bottleneckTitle}</span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--sim-text-sub)', marginTop: 4, lineHeight: 1.4 }}>
                {simulation.bottleneckDesc}
              </div>
            </div>

            {/* Daily Throughput */}
            <div style={{ borderLeft: '1px solid var(--sim-rule)', paddingLeft: 'var(--space-5)' }}>
              <div className="label-caps" style={{ color: 'var(--sim-accent-secondary)', letterSpacing: '0.14em', marginBottom: 4 }}>
                MARKING VELOCITY CAPACITY
              </div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--sim-accent-primary)' }}>
                {simulation.dailyEvalCapacity.toLocaleString()} <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--sim-text-sub)' }}>scripts/day</span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--sim-text-sub)', marginTop: 4 }}>
                ~{simulation.scriptsPerExaminer.toLocaleString()} scripts per examiner pool
              </div>
            </div>

            {/* Copy Docket Button */}
            <div style={{ textAlign: 'right' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleCopyMemo}
                style={{ width: '100%', padding: '12px 16px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
              >
                <span>{copiedMemo ? '✓ Audit Memo Copied' : '📋 Export Audit Memo'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* INTERACTIVE PLAYBACK & LIVE PIPELINE NODE FLOW CONTROLLER                */}
      {/* ========================================================================= */}
      <div
        className="folio-card"
        style={{
          marginBottom: 'var(--space-6)',
          background: 'var(--sim-card-bg)',
          borderColor: 'var(--sim-card-border)',
          boxShadow: 'var(--sim-glow)',
        }}
      >
        <div
          className="folio-card__header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--sim-rule)',
            padding: '12px 20px',
          }}
        >
          <div>
            <div className="folio-card__eyebrow" style={{ color: 'var(--sim-accent-secondary)' }}>
              CADENCE ENGINE // LIVE TIMELINE PLAYHEAD
            </div>
            <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: 'var(--sim-text-main)' }}>
              Interactive Daily Examination Simulation
            </h2>
          </div>

          {/* Player Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: '12px', padding: '6px 10px', border: '1px solid var(--sim-rule)' }}
              onClick={() => {
                setIsPlaying(false);
                setSimulatedDay(0);
              }}
              title="Reset to Day 0"
            >
              ⏮ Reset
            </button>

            <button
              type="button"
              className="btn"
              style={{
                fontSize: '13px',
                padding: '7px 16px',
                background: isPlaying ? 'var(--sim-accent-amber)' : 'var(--sim-accent-primary)',
                color: '#FFFFFF',
                border: 'none',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
              }}
              onClick={() => setIsPlaying((p) => !p)}
            >
              <span>{isPlaying ? '⏸ Pause' : '▶ Run Simulation'}</span>
            </button>

            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: '12px', padding: '6px 10px', border: '1px solid var(--sim-rule)' }}
              onClick={() => {
                setIsPlaying(false);
                setSimulatedDay(simulation.totalWorkingDays);
              }}
              title="Skip to Gazetting"
            >
              ⏭ Finish
            </button>

            {/* Playback speed multiplier */}
            <div style={{ display: 'flex', border: '1px solid var(--sim-rule)', borderRadius: 3, overflow: 'hidden' }}>
              {[1, 2, 4].map((speed) => (
                <button
                  key={speed}
                  type="button"
                  onClick={() => setPlaybackSpeed(speed)}
                  style={{
                    padding: '4px 8px',
                    fontSize: '11px',
                    fontWeight: 700,
                    border: 'none',
                    background: playbackSpeed === speed ? 'var(--sim-accent-primary)' : 'var(--sim-card-bg)',
                    color: playbackSpeed === speed ? '#FFFFFF' : 'var(--sim-text-sub)',
                    cursor: 'pointer',
                  }}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="folio-card__body" style={{ padding: 'var(--space-5)' }}>
          {/* Day Scrubber Slider & Progress Counter */}
          <div style={{ marginBottom: 'var(--space-5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    padding: '3px 8px',
                    borderRadius: 3,
                    background: liveMetrics.stageColor,
                    color: '#FFFFFF',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                  }}
                >
                  DAY {simulatedDay} OF {simulation.totalWorkingDays}
                </span>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--sim-text-main)' }}>
                  {liveMetrics.stageName}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--sim-text-sub)', fontFamily: 'var(--font-mono)' }}>
                {liveMetrics.pctMarked}% Marked · {liveMetrics.pctModerated}% Moderated
              </div>
            </div>

            <input
              type="range"
              min={0}
              max={simulation.totalWorkingDays}
              step={1}
              value={simulatedDay}
              onChange={(e) => {
                setIsPlaying(false);
                setSimulatedDay(Number(e.target.value));
              }}
              className="sim-range-input"
              style={{ width: '100%', cursor: 'pointer' }}
            />
          </div>

          {/* Animated 4-Stage Pipeline Conduit Flow */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 'var(--space-3)',
              position: 'relative',
            }}
          >
            {/* Stage 1: Registered Archive */}
            <div
              style={{
                background: 'var(--sim-pipeline-node)',
                border: '1px solid var(--sim-card-border)',
                borderRadius: '4px',
                padding: '12px 14px',
                transition: 'all 0.3s',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--sim-accent-secondary)' }}>
                  01. INGESTION DEPOT
                </span>
                <span style={{ fontSize: '10px', color: 'var(--sim-text-sub)' }}>Registered</span>
              </div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--sim-text-main)', margin: '4px 0' }}>
                {totalScripts.toLocaleString()}{' '}
                <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--sim-text-sub)' }}>scripts</span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                {liveMetrics.pendingMarking > 0
                  ? `${liveMetrics.pendingMarking.toLocaleString()} awaiting marking floor`
                  : '✓ All scripts dispatched'}
              </div>
            </div>

            {/* Stage 2: Examiner Pool */}
            <div
              style={{
                background: 'var(--sim-pipeline-node)',
                border: `1px solid ${simulatedDay > 0 && !liveMetrics.isCompleted ? 'var(--sim-accent-primary)' : 'var(--sim-card-border)'}`,
                boxShadow: simulatedDay > 0 && !liveMetrics.isCompleted ? 'var(--sim-glow)' : 'none',
                borderRadius: '4px',
                padding: '12px 14px',
                transition: 'all 0.3s',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--sim-accent-primary)' }}>
                  02. MARKING FLOOR
                </span>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    color: liveMetrics.pctMarked === 100 ? 'var(--sim-accent-emerald)' : 'var(--sim-accent-primary)',
                  }}
                >
                  {liveMetrics.pctMarked}%
                </span>
              </div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--sim-accent-primary)', margin: '4px 0' }}>
                {liveMetrics.marked.toLocaleString()}{' '}
                <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--sim-text-sub)' }}>marked</span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                {activeExaminers} examiners @ {evalPace}/day
              </div>
            </div>

            {/* Stage 3: Moderation Audit Vault */}
            <div
              style={{
                background: 'var(--sim-pipeline-node)',
                border: `1px solid ${
                  simulatedDay > 1 && liveMetrics.pctModerated < 100
                    ? 'var(--sim-accent-secondary)'
                    : 'var(--sim-card-border)'
                }`,
                borderRadius: '4px',
                padding: '12px 14px',
                transition: 'all 0.3s',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--sim-accent-secondary)' }}>
                  03. MODERATION VAULT
                </span>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    color: liveMetrics.pctModerated === 100 ? 'var(--sim-accent-emerald)' : 'var(--sim-accent-secondary)',
                  }}
                >
                  {liveMetrics.pctModerated}%
                </span>
              </div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--sim-accent-secondary)', margin: '4px 0' }}>
                {liveMetrics.moderated.toLocaleString()}{' '}
                <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--sim-text-sub)' }}>audited</span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                {modSamplePct}% sample ({simulation.modScriptsTotal} total)
              </div>
            </div>

            {/* Stage 4: Gazetted Docket */}
            <div
              style={{
                background: 'var(--sim-pipeline-node)',
                border: `1px solid ${liveMetrics.isCompleted ? 'var(--sim-accent-emerald)' : 'var(--sim-card-border)'}`,
                boxShadow: liveMetrics.isCompleted ? '0 0 16px rgba(16, 185, 129, 0.25)' : 'none',
                borderRadius: '4px',
                padding: '12px 14px',
                transition: 'all 0.3s',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--sim-accent-emerald)' }}>
                  04. GAZETTED DOCKET
                </span>
                <span style={{ fontSize: '10px', fontWeight: 600, color: liveMetrics.isCompleted ? 'var(--sim-accent-emerald)' : 'var(--sim-text-sub)' }}>
                  {liveMetrics.isCompleted ? 'PUBLISHED' : 'PENDING'}
                </span>
              </div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: liveMetrics.isCompleted ? 'var(--sim-accent-emerald)' : 'var(--sim-text-main)', margin: '4px 0' }}>
                {liveMetrics.isCompleted ? '100% Sealed' : `Day ${simulation.totalWorkingDays}`}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                {liveMetrics.isCompleted ? simulation.completionDateFormatted : 'Final result ledger gazetting'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* MAIN TWO-COLUMN WORKSPACE: CONTROLS & VISUALIZATION                       */}
      {/* ========================================================================= */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1.35fr', gap: 'var(--space-6)' }}>
        {/* LEFT COLUMN: SIMULATOR CONTROLS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          {/* Section 1: Examiner Marking Controls */}
          <div
            className="folio-card"
            style={{
              background: 'var(--sim-card-bg)',
              borderColor: 'var(--sim-card-border)',
            }}
          >
            <div className="folio-card__header">
              <div className="folio-card__eyebrow" style={{ color: 'var(--sim-accent-secondary)' }}>
                STAGE 01 // ON-SCREEN MARKING CAPACITY
              </div>
              <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--sim-text-main)', margin: 0 }}>
                Examiner Pool Parameters
              </h2>
            </div>
            <div
              className="folio-card__body"
              style={{ padding: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
            >
              {/* Total Scripts */}
              <div className="form-field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="form-label" htmlFor="inp-scripts" style={{ color: 'var(--sim-text-main)' }}>
                    1. TOTAL CANDIDATE SCRIPTS
                  </label>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--sim-accent-primary)' }}>
                    {totalScripts.toLocaleString()}
                  </span>
                </div>
                <input
                  id="inp-scripts"
                  type="range"
                  min={200}
                  max={25000}
                  step={100}
                  value={totalScripts}
                  onChange={(e) => setTotalScripts(Number(e.target.value))}
                  className="sim-range-input"
                  style={{ width: '100%', cursor: 'pointer' }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  {[1500, 3000, 5000, 10000, 20000].map((num) => (
                    <button
                      key={num}
                      type="button"
                      onClick={() => setTotalScripts(num)}
                      style={{
                        padding: '3px 8px',
                        fontSize: '10px',
                        fontWeight: 600,
                        border: '1px solid var(--sim-card-border)',
                        background: totalScripts === num ? 'var(--sim-accent-primary)' : 'var(--sim-pipeline-node)',
                        color: totalScripts === num ? '#FFFFFF' : 'var(--sim-text-sub)',
                        cursor: 'pointer',
                        borderRadius: 3,
                      }}
                    >
                      {num.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ height: 1, background: 'var(--sim-rule)', margin: '2px 0' }} />

              {/* Active Examiners */}
              <div className="form-field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="form-label" htmlFor="inp-examiners" style={{ color: 'var(--sim-text-main)' }}>
                    2. ACCREDITED EXAMINERS ALLOCATED
                  </label>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--sim-accent-primary)' }}>
                    {activeExaminers} Examiners
                  </span>
                </div>
                <input
                  id="inp-examiners"
                  type="range"
                  min={2}
                  max={80}
                  step={1}
                  value={activeExaminers}
                  onChange={(e) => setActiveExaminers(Number(e.target.value))}
                  className="sim-range-input"
                  style={{ width: '100%', cursor: 'pointer' }}
                />
              </div>

              {/* Evaluation Pace */}
              <div className="form-field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="form-label" htmlFor="inp-pace" style={{ color: 'var(--sim-text-main)' }}>
                    3. MARKING PACE (SCRIPTS / EXAMINER / DAY)
                  </label>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 700,
                      color: evalPace > 30 ? 'var(--sim-accent-crimson)' : 'var(--sim-accent-secondary)',
                    }}
                  >
                    {evalPace} scripts/day
                  </span>
                </div>
                <input
                  id="inp-pace"
                  type="range"
                  min={5}
                  max={50}
                  step={1}
                  value={evalPace}
                  onChange={(e) => setEvalPace(Number(e.target.value))}
                  className="sim-range-input"
                  style={{ width: '100%', cursor: 'pointer' }}
                />
                <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                  Institutional benchmark: 18 – 28 scripts per examiner daily.
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Moderation & Calendar Schedule */}
          <div
            className="folio-card"
            style={{
              background: 'var(--sim-card-bg)',
              borderColor: 'var(--sim-card-border)',
            }}
          >
            <div className="folio-card__header">
              <div className="folio-card__eyebrow" style={{ color: 'var(--sim-accent-secondary)' }}>
                STAGE 02 // GOVERNANCE & MODERATION REVIEW
              </div>
              <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--sim-text-main)', margin: 0 }}>
                Moderation & Schedule Discipline
              </h2>
            </div>
            <div
              className="folio-card__body"
              style={{ padding: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
            >
              {/* Moderation Sample Rate */}
              <div className="form-field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="form-label" htmlFor="inp-mod-sample" style={{ color: 'var(--sim-text-main)' }}>
                    4. QUALITY AUDIT SAMPLING RATE
                  </label>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--sim-accent-secondary)' }}>
                    {modSamplePct}% ({simulation.modScriptsTotal} scripts)
                  </span>
                </div>
                <input
                  id="inp-mod-sample"
                  type="range"
                  min={5}
                  max={30}
                  step={1}
                  value={modSamplePct}
                  onChange={(e) => setModSamplePct(Number(e.target.value))}
                  className="sim-range-input"
                  style={{ width: '100%', cursor: 'pointer' }}
                />
              </div>

              {/* Active Moderators & Moderator Pace */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                <div className="form-field">
                  <label className="form-label" htmlFor="inp-mod-count" style={{ color: 'var(--sim-text-main)' }}>
                    5. SENIOR MODERATORS
                  </label>
                  <input
                    id="inp-mod-count"
                    type="number"
                    min={1}
                    max={20}
                    value={activeModerators}
                    onChange={(e) => setActiveModerators(Number(e.target.value))}
                    className="form-input"
                    style={{ background: 'var(--sim-pipeline-node)', color: 'var(--sim-text-main)' }}
                  />
                </div>

                <div className="form-field">
                  <label className="form-label" htmlFor="inp-mod-pace" style={{ color: 'var(--sim-text-main)' }}>
                    6. MODERATOR PACE
                  </label>
                  <input
                    id="inp-mod-pace"
                    type="number"
                    min={5}
                    max={80}
                    value={modPace}
                    onChange={(e) => setModPace(Number(e.target.value))}
                    className="form-input"
                    style={{ background: 'var(--sim-pipeline-node)', color: 'var(--sim-text-main)' }}
                  />
                </div>
              </div>

              {/* Working Days & Start Date */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                <div className="form-field">
                  <label className="form-label" htmlFor="inp-work-week" style={{ color: 'var(--sim-text-main)' }}>
                    7. WORKING WEEK
                  </label>
                  <select
                    id="inp-work-week"
                    value={workDaysPerWeek}
                    onChange={(e) => setWorkDaysPerWeek(Number(e.target.value))}
                    className="form-select"
                    style={{ background: 'var(--sim-pipeline-node)', color: 'var(--sim-text-main)' }}
                  >
                    <option value={5}>5 Days (Mon – Fri)</option>
                    <option value={6}>6 Days (Mon – Sat)</option>
                  </select>
                </div>

                <div className="form-field">
                  <label className="form-label" htmlFor="inp-start-date" style={{ color: 'var(--sim-text-main)' }}>
                    8. COMMENCEMENT DATE
                  </label>
                  <input
                    id="inp-start-date"
                    type="date"
                    value={startDateStr}
                    onChange={(e) => setStartDateStr(e.target.value)}
                    className="form-input"
                    style={{ background: 'var(--sim-pipeline-node)', color: 'var(--sim-text-main)' }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Interactive Scenario Levers (Instant What-Ifs) */}
          <div
            className="folio-card"
            style={{
              background: 'var(--sim-card-bg)',
              borderColor: 'var(--sim-card-border)',
            }}
          >
            <div className="folio-card__header">
              <div className="folio-card__eyebrow" style={{ color: 'var(--sim-accent-secondary)' }}>
                SCENARIO LAB // WHAT-IF LEVERS
              </div>
              <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--sim-text-main)', margin: 0 }}>
                Instant Sensitivity Actions
              </h2>
            </div>
            <div className="folio-card__body" style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Lever 1 */}
              <div
                className="sim-interactive-lever"
                onClick={() => setActiveExaminers((e) => e + 5)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 14px',
                  background: 'var(--sim-pipeline-node)',
                  border: '1px solid var(--sim-card-border)',
                  borderRadius: 4,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--sim-text-main)' }}>
                    👥 Enlist +5 Examiners (Pool: {activeExaminers + 5})
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                    Expands daily capacity to {(activeExaminers + 5) * evalPace} scripts/day.
                  </div>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--sim-accent-emerald)', fontSize: '12px' }}>
                  -{simulation.whatIf.daysSavedWithExaminers} Days
                </span>
              </div>

              {/* Lever 2 */}
              <div
                className="sim-interactive-lever"
                onClick={() => setEvalPace((p) => Math.min(45, p + 5))}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 14px',
                  background: 'var(--sim-pipeline-node)',
                  border: '1px solid var(--sim-card-border)',
                  borderRadius: 4,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--sim-text-main)' }}>
                    🚀 Overtime Velocity (+5 Scripts/Day)
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                    Simulates incentivized marking sessions.
                  </div>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--sim-accent-primary)', fontSize: '12px' }}>
                  Accelerate
                </span>
              </div>

              {/* Lever 3 */}
              <div
                className="sim-interactive-lever"
                onClick={() => setModSamplePct(20)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 14px',
                  background: 'var(--sim-pipeline-node)',
                  border: '1px solid var(--sim-card-border)',
                  borderRadius: 4,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--sim-text-main)' }}>
                    🛡️ High-Stakes 20% Double-Audit
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                    Doubles quality scrutiny for medical/legal examinations.
                  </div>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--sim-accent-secondary)', fontSize: '12px' }}>
                  {Math.ceil((totalScripts * 0.2) / simulation.dailyModCapacity)} Mod Days
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: TABBED VISUALIZATION (GANTT, CURVE, DIAGNOSTICS) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <div
            className="folio-card"
            style={{
              background: 'var(--sim-card-bg)',
              borderColor: 'var(--sim-card-border)',
              boxShadow: 'var(--sim-glow)',
            }}
          >
            {/* View Switcher Tabs */}
            <div
              style={{
                display: 'flex',
                borderBottom: '1px solid var(--sim-rule)',
                background: 'var(--sim-pipeline-node)',
              }}
            >
              <button
                type="button"
                className={`sim-tab-btn ${activeTab === 'gantt' ? 'active' : ''}`}
                style={{ flex: 1, border: 'none', borderRight: '1px solid var(--sim-rule)' }}
                onClick={() => setActiveTab('gantt')}
              >
                📊 Timeline Gantt & Milestones
              </button>
              <button
                type="button"
                className={`sim-tab-btn ${activeTab === 'curve' ? 'active' : ''}`}
                style={{ flex: 1, border: 'none', borderRight: '1px solid var(--sim-rule)' }}
                onClick={() => setActiveTab('curve')}
              >
                📈 Burn-Up & Capacity S-Curve
              </button>
              <button
                type="button"
                className={`sim-tab-btn ${activeTab === 'diagnostics' ? 'active' : ''}`}
                style={{ flex: 1, border: 'none' }}
                onClick={() => setActiveTab('diagnostics')}
              >
                ⚡ Quality & Fatigue Radar
              </button>
            </div>

            <div className="folio-card__body" style={{ padding: 'var(--space-5)' }}>
              {/* ========================================================= */}
              {/* TAB 1: VISUAL GANTT CADENCE WITH LIVE PLAYHEAD INDICATOR  */}
              {/* ========================================================= */}
              {activeTab === 'gantt' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div>
                      <div className="label-caps" style={{ color: 'var(--sim-accent-secondary)' }}>
                        OPERATIONAL STAGE FORECAST
                      </div>
                      <div style={{ fontSize: '13px', color: 'var(--sim-text-sub)' }}>
                        Relative timeline durations mapped over {simulation.totalWorkingDays} working days.
                      </div>
                    </div>
                    {simulatedDay > 0 && (
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '3px 8px',
                          borderRadius: 3,
                          background: 'var(--sim-accent-primary)',
                          color: '#FFFFFF',
                        }}
                      >
                        Playhead: Day {simulatedDay}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                    {/* Stage 1: Marking */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, color: 'var(--sim-text-main)' }}>
                          1. Script Marking Phase ({activeExaminers} Examiners)
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--sim-accent-primary)', fontWeight: 700 }}>
                          Days 1 – {simulation.evalWorkingDays} ({simulation.evalWorkingDays} Working Days)
                        </span>
                      </div>
                      <div
                        style={{
                          height: 22,
                          background: 'var(--sim-track-bg)',
                          border: '1px solid var(--sim-card-border)',
                          borderRadius: 3,
                          overflow: 'hidden',
                          position: 'relative',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.min(100, (simulation.evalWorkingDays / simulation.totalWorkingDays) * 100)}%`,
                            background: 'var(--sim-accent-primary)',
                            boxShadow: '0 0 10px var(--sim-pulse)',
                            transition: 'width 0.3s ease',
                          }}
                        />
                        {/* Playhead Marker */}
                        {simulatedDay > 0 && (
                          <div
                            style={{
                              position: 'absolute',
                              top: 0,
                              bottom: 0,
                              left: `${(simulatedDay / simulation.totalWorkingDays) * 100}%`,
                              width: 2,
                              background: '#FFFFFF',
                              boxShadow: '0 0 4px #000',
                            }}
                          />
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)', marginTop: 2 }}>
                        Clears {simulation.dailyEvalCapacity} scripts daily across {activeExaminers} active allocation pools.
                      </div>
                    </div>

                    {/* Stage 2: Moderation */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, color: 'var(--sim-text-main)' }}>
                          2. Moderation & Verification ({activeModerators} Reviewers)
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--sim-accent-secondary)', fontWeight: 700 }}>
                          Days 2 – {simulation.totalWorkingDays - 1} ({simulation.modWorkingDays} Working Days)
                        </span>
                      </div>
                      <div
                        style={{
                          height: 22,
                          background: 'var(--sim-track-bg)',
                          border: '1px solid var(--sim-card-border)',
                          borderRadius: 3,
                          overflow: 'hidden',
                          position: 'relative',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.min(100, (simulation.modWorkingDays / simulation.totalWorkingDays) * 100)}%`,
                            background: 'var(--sim-accent-secondary)',
                            boxShadow: '0 0 10px var(--sim-pulse)',
                            transition: 'width 0.3s ease',
                          }}
                        />
                        {simulatedDay > 0 && (
                          <div
                            style={{
                              position: 'absolute',
                              top: 0,
                              bottom: 0,
                              left: `${(simulatedDay / simulation.totalWorkingDays) * 100}%`,
                              width: 2,
                              background: '#FFFFFF',
                              boxShadow: '0 0 4px #000',
                            }}
                          />
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)', marginTop: 2 }}>
                        Samples {modSamplePct}% ({simulation.modScriptsTotal} scripts). Velocity: {simulation.dailyModCapacity} scripts/day.
                      </div>
                    </div>

                    {/* Stage 3: Gazetting */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, color: 'var(--sim-text-main)' }}>
                          3. Final Result Audit & Official Gazetting
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--sim-accent-emerald)', fontWeight: 700 }}>
                          Day {simulation.totalWorkingDays}
                        </span>
                      </div>
                      <div
                        style={{
                          height: 22,
                          background: 'var(--sim-track-bg)',
                          border: '1px solid var(--sim-card-border)',
                          borderRadius: 3,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: '100%',
                            background: 'var(--sim-accent-emerald)',
                            boxShadow: '0 0 10px rgba(16, 185, 129, 0.2)',
                          }}
                        />
                      </div>
                    </div>

                    {/* Milestones Checkpoints */}
                    <div style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--sim-rule)', paddingTop: 'var(--space-3)' }}>
                      <div className="label-caps" style={{ color: 'var(--sim-accent-secondary)', marginBottom: 8 }}>
                        CRITICAL PIPELINE MILESTONES
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                        <div style={{ padding: '8px 10px', background: 'var(--sim-pipeline-node)', borderRadius: 3 }}>
                          <div style={{ fontSize: '10px', color: 'var(--sim-text-sub)' }}>BATCH 01 DISPATCH</div>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--sim-text-main)' }}>Day 1</div>
                        </div>
                        <div style={{ padding: '8px 10px', background: 'var(--sim-pipeline-node)', borderRadius: 3 }}>
                          <div style={{ fontSize: '10px', color: 'var(--sim-text-sub)' }}>50% MARKING HALFWAY</div>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--sim-accent-primary)' }}>
                            Day {Math.ceil(simulation.evalWorkingDays / 2)}
                          </div>
                        </div>
                        <div style={{ padding: '8px 10px', background: 'var(--sim-pipeline-node)', borderRadius: 3 }}>
                          <div style={{ fontSize: '10px', color: 'var(--sim-text-sub)' }}>MARKING CONCLUDED</div>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--sim-accent-secondary)' }}>
                            Day {simulation.evalWorkingDays}
                          </div>
                        </div>
                        <div style={{ padding: '8px 10px', background: 'var(--sim-pipeline-node)', borderRadius: 3 }}>
                          <div style={{ fontSize: '10px', color: 'var(--sim-text-sub)' }}>GAZETTING READY</div>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--sim-accent-emerald)' }}>
                            Day {simulation.totalWorkingDays}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ========================================================= */}
              {/* TAB 2: INTERACTIVE CUMULATIVE S-CURVE & CAPACITY SVG      */}
              {/* ========================================================= */}
              {activeTab === 'curve' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div>
                      <div className="label-caps" style={{ color: 'var(--sim-accent-secondary)' }}>
                        CUMULATIVE SCRIPTS BURN-UP
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--sim-text-sub)' }}>
                        Interactive curve showing evaluated script velocity vs target volume.
                      </div>
                    </div>
                    {/* Legend */}
                    <div style={{ display: 'flex', gap: 12, fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--sim-svg-eval-line)' }} />
                        Evaluated
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--sim-svg-mod-line)' }} />
                        Moderated
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 8, height: 2, background: 'var(--sim-svg-target)' }} />
                        Target Ceiling
                      </span>
                    </div>
                  </div>

                  {/* High Precision SVG Chart */}
                  <div style={{ width: '100%', height: 260, position: 'relative' }}>
                    <svg
                      width="100%"
                      height="100%"
                      viewBox="0 0 540 240"
                      preserveAspectRatio="none"
                      style={{ overflow: 'visible' }}
                    >
                      {/* Grid Lines */}
                      {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => (
                        <g key={i}>
                          <line
                            x1="40"
                            y1={20 + (1 - pct) * 190}
                            x2="520"
                            y2={20 + (1 - pct) * 190}
                            stroke="var(--sim-svg-grid)"
                            strokeWidth="1"
                            strokeDasharray={pct === 1 ? '4 4' : 'none'}
                          />
                          <text
                            x="35"
                            y={24 + (1 - pct) * 190}
                            fill="var(--sim-text-sub)"
                            fontSize="9"
                            textAnchor="end"
                            fontFamily="var(--font-mono)"
                          >
                            {Math.round(totalScripts * pct).toLocaleString()}
                          </text>
                        </g>
                      ))}

                      {/* Cumulative Evaluated Area and Line */}
                      {(() => {
                        const pts = simulation.curvePoints;
                        if (!pts.length) return null;
                        const getX = (idx: number) => 40 + (idx / Math.max(1, pts.length - 1)) * 480;
                        const getY = (val: number) => 210 - (val / totalScripts) * 190;

                        const lineD = pts
                          .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${getX(idx)} ${getY(p.cumulativeMarked)}`)
                          .join(' ');
                        const areaD = `${lineD} L ${getX(pts.length - 1)} 210 L 40 210 Z`;

                        const modLineD = pts
                          .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${getX(idx)} ${getY(p.cumulativeModerated)}`)
                          .join(' ');

                        return (
                          <>
                            <path d={areaD} fill="var(--sim-svg-eval-fill)" />
                            <path
                              d={lineD}
                              fill="none"
                              stroke="var(--sim-svg-eval-line)"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                            />
                            <path
                              d={modLineD}
                              fill="none"
                              stroke="var(--sim-svg-mod-line)"
                              strokeWidth="2"
                              strokeDasharray="4 3"
                            />

                            {/* Live Scrubber Indicator on SVG */}
                            {simulatedDay > 0 && (
                              <g>
                                <line
                                  x1={getX(Math.min(pts.length - 1, simulatedDay - 1))}
                                  y1="20"
                                  x2={getX(Math.min(pts.length - 1, simulatedDay - 1))}
                                  y2="210"
                                  stroke="var(--sim-accent-primary)"
                                  strokeWidth="1.5"
                                  strokeDasharray="3 3"
                                />
                                <circle
                                  cx={getX(Math.min(pts.length - 1, simulatedDay - 1))}
                                  cy={getY(liveMetrics.marked)}
                                  r="4.5"
                                  fill="var(--sim-accent-primary)"
                                  stroke="#FFFFFF"
                                  strokeWidth="1.5"
                                />
                              </g>
                            )}

                            {/* Interactive Hover Point */}
                            {chartHoverDay !== null && chartHoverDay >= 1 && chartHoverDay <= pts.length && (
                              <g>
                                <circle
                                  cx={getX(chartHoverDay - 1)}
                                  cy={getY(pts[chartHoverDay - 1].cumulativeMarked)}
                                  r="5"
                                  fill="var(--sim-accent-secondary)"
                                  stroke="#FFFFFF"
                                  strokeWidth="2"
                                />
                              </g>
                            )}
                          </>
                        );
                      })()}
                    </svg>
                  </div>

                  {/* Bottom Day Tick Marks */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 40, marginTop: 4 }}>
                    <span style={{ fontSize: '10px', color: 'var(--sim-text-sub)', fontFamily: 'var(--font-mono)' }}>
                      Day 1
                    </span>
                    <span style={{ fontSize: '10px', color: 'var(--sim-text-sub)', fontFamily: 'var(--font-mono)' }}>
                      Day {Math.ceil(simulation.totalWorkingDays / 2)}
                    </span>
                    <span style={{ fontSize: '10px', color: 'var(--sim-text-sub)', fontFamily: 'var(--font-mono)' }}>
                      Day {simulation.totalWorkingDays} (Final Gazetting)
                    </span>
                  </div>
                </div>
              )}

              {/* ========================================================= */}
              {/* TAB 3: QUALITY, STRESS & FATIGUE DIAGNOSTIC MATRIX        */}
              {/* ========================================================= */}
              {activeTab === 'diagnostics' && (
                <div>
                  <div className="label-caps" style={{ color: 'var(--sim-accent-secondary)', marginBottom: 8 }}>
                    EXAMINATION GOVERNANCE & INTEGRITY METRICS
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
                    {/* Metric 1 */}
                    <div style={{ padding: 'var(--space-4)', background: 'var(--sim-pipeline-node)', border: '1px solid var(--sim-card-border)', borderRadius: 4 }}>
                      <div className="label-caps" style={{ color: 'var(--sim-text-sub)', fontSize: '10px' }}>
                        EXAMINER COGNITIVE LOAD INDEX
                      </div>
                      <div
                        style={{
                          fontSize: '22px',
                          fontWeight: 700,
                          color:
                            simulation.examinerFatigueScore > 75
                              ? 'var(--sim-accent-crimson)'
                              : simulation.examinerFatigueScore > 50
                              ? 'var(--sim-accent-amber)'
                              : 'var(--sim-accent-emerald)',
                          margin: '4px 0',
                        }}
                      >
                        {simulation.examinerFatigueScore}/100{' '}
                        <span style={{ fontSize: '11px', fontWeight: 500 }}>
                          ({simulation.examinerFatigueScore > 75 ? 'Fatigue Alert' : 'Healthy Cadence'})
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                        Based on daily pace ({evalPace} scripts) and duration ({simulation.evalWorkingDays} days).
                      </div>
                    </div>

                    {/* Metric 2 */}
                    <div style={{ padding: 'var(--space-4)', background: 'var(--sim-pipeline-node)', border: '1px solid var(--sim-card-border)', borderRadius: 4 }}>
                      <div className="label-caps" style={{ color: 'var(--sim-text-sub)', fontSize: '10px' }}>
                        PROJECTED APPEAL / VARIANCE RISK
                      </div>
                      <div
                        style={{
                          fontSize: '22px',
                          fontWeight: 700,
                          color:
                            simulation.appealRiskScore > 40
                              ? 'var(--sim-accent-amber)'
                              : 'var(--sim-accent-emerald)',
                          margin: '4px 0',
                        }}
                      >
                        {simulation.appealRiskScore}% Risk{' '}
                        <span style={{ fontSize: '11px', fontWeight: 500 }}>
                          ({simulation.appealRiskScore > 40 ? 'Moderate' : 'Low'})
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                        Mitigated by {modSamplePct}% double-audit moderation sampling.
                      </div>
                    </div>
                  </div>

                  {/* Capacity Balance Meter */}
                  <div style={{ padding: '12px 16px', background: 'var(--sim-pipeline-node)', border: '1px solid var(--sim-card-border)', borderRadius: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--sim-text-main)' }}>
                        Moderation Queue Clearance Ratio
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 700,
                          color: simulation.modCapacityRatio >= 1 ? 'var(--sim-accent-emerald)' : 'var(--sim-accent-crimson)',
                        }}
                      >
                        {Math.round(simulation.modCapacityRatio * 100)}% Capacity
                      </span>
                    </div>
                    <div
                      style={{
                        height: 8,
                        background: 'var(--sim-track-bg)',
                        borderRadius: 4,
                        overflow: 'hidden',
                        margin: '6px 0',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, simulation.modCapacityRatio * 100)}%`,
                          background: simulation.modCapacityRatio >= 1 ? 'var(--sim-accent-emerald)' : 'var(--sim-accent-crimson)',
                          borderRadius: 4,
                        }}
                      />
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--sim-text-sub)' }}>
                      Incoming daily moderation demand: ~{simulation.dailyModIncoming} scripts/day · Active moderator capacity: {simulation.dailyModCapacity} scripts/day.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
