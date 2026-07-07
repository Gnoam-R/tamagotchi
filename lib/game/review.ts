import type { ActionEffect } from "@/types/action";
import type {
  Character,
  CharacterStatus,
  Degree,
  LifeEventRecord,
  LifeStage,
  ReviewGrade,
  WorkReview,
  YearCounters,
  YearlyReview,
} from "@/types/character";
import {
  CHILDBIRTH_COST,
  MARRIAGE_COST,
  rollChildbirth,
  rollMarriage,
  rollYearlyEvent,
} from "./events";
import { clamp, round2 } from "./clamp";
import {
  EDU_STAGES,
  MAX_AGE,
  MAX_NEGLECT_YEARS_APPLIED,
  YEARLY_TARGETS,
} from "./constants";
import { applyEffect } from "./engine";
import { isActionUnlocked } from "./gating";
import { cappedStageForAge } from "./growth";
import { computeExamScore, examEffect, examTier } from "./exam";
import { processWorkReview } from "./work";
import { rollLifeRisk, updateHappiness, yearlyNet } from "./life";
import {
  BACHELOR_AGE,
  DEGREE_YEARS,
  GRAD_TUITION,
  gradYearEffect,
} from "./degree";
import { processHousingYear, housingHappiness } from "./housing";
import { processUniversityYear } from "./university";
import { weightVerdict } from "./weight";

/**
 * 한 해 학위 처리: 학사 자동 취득(대학 졸업) + 대학원(석/박사) 진행·졸업.
 * 대학원 재학 중이면 학업·지능 폭증 + 등록금(저축 감소). 졸업 시 학위 갱신.
 */
function processDegreeYear(
  ch: Character,
  year: number,
): { ch: Character; change?: { to: Degree } } {
  let change: { to: Degree } | undefined;
  if (ch.degree === "highschool" && year >= BACHELOR_AGE) {
    ch = { ...ch, degree: "bachelor" };
    change = { to: "bachelor" };
  }
  if (ch.gradEnroll) {
    const g = ch.gradEnroll;
    ch = applyEffect(ch, gradYearEffect());
    ch = { ...ch, savings: ch.savings - GRAD_TUITION };
    if (year - g.startAge >= DEGREE_YEARS[g.degree]) {
      ch = { ...ch, degree: g.degree, gradEnroll: null };
      change = { to: g.degree };
    }
  }
  return { ch, change };
}

const ZERO_COUNTERS: YearCounters = {
  study: 0,
  exercise: 0,
  selfDev: 0,
  meals: 0,
};

function isAdultStage(stage: LifeStage): boolean {
  return stage === "employee" || stage === "senior" || stage === "retirement";
}

// --- 효과 합성 유틸 (키별 합산 / 스케일) ---

function mergeDelta(
  a?: Record<string, number>,
  b?: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const k of Object.keys(src)) {
      out[k] = (out[k] ?? 0) + (src[k] ?? 0);
    }
  }
  return out;
}

export function mergeEffect(a: ActionEffect, b: ActionEffect): ActionEffect {
  return {
    status: mergeDelta(
      a.status as unknown as Record<string, number>,
      b.status as unknown as Record<string, number>,
    ) as unknown as ActionEffect["status"],
    stats: mergeDelta(
      a.stats as unknown as Record<string, number>,
      b.stats as unknown as Record<string, number>,
    ) as unknown as ActionEffect["stats"],
    exp: (a.exp ?? 0) + (b.exp ?? 0),
  };
}

function scaleDelta(
  d: Record<string, number> | undefined,
  k: number,
): Record<string, number> | undefined {
  if (!d) return undefined;
  const out: Record<string, number> = {};
  for (const key of Object.keys(d)) out[key] = round2(d[key] * k);
  return out;
}

export function scaleEffect(e: ActionEffect, k: number): ActionEffect {
  return {
    status: scaleDelta(
      e.status as unknown as Record<string, number>,
      k,
    ) as unknown as ActionEffect["status"],
    stats: scaleDelta(
      e.stats as unknown as Record<string, number>,
      k,
    ) as unknown as ActionEffect["stats"],
    exp: e.exp ? Math.round(e.exp * k) : undefined,
  };
}

// --- 연간 평가 점수 (PRD 5.3) ---

export function scoreYear(
  counters: YearCounters,
  status: CharacterStatus,
  age: number,
  opts?: { neutralStatus?: boolean; gender?: import("@/types/character").Gender },
): number {
  const T = YEARLY_TARGETS;
  const cap = (count: number, target: number) =>
    Math.min(count / target, 1) * 100;
  // 다년 점프 시: status 는 전체 오프라인 기간만큼 누적 감쇠돼 직전 "1년" 채점에
  // 부당하므로 status 기반 항목을 중립값으로 대체한다.
  const neutral = opts?.neutralStatus ?? false;
  const health = neutral ? 50 : status.health;
  const sleep = neutral ? 50 : status.sleepQuality;
  const stress = neutral ? 50 : status.stress;
  const weightScore = neutral
    ? 70
    : weightVerdict(status.weight, age, opts?.gender) === "healthy"
      ? 100
      : 40;
  const raw =
    cap(counters.study, T.study) * 0.22 +
    cap(counters.selfDev, T.selfDev) * 0.2 +
    cap(counters.exercise, T.exercise) * 0.18 +
    cap(counters.meals, T.meals) * 0.1 +
    health * 0.12 +
    sleep * 0.08 +
    (100 - stress) * 0.05 +
    weightScore * 0.05;
  return clamp(Math.round(raw), 0, 100);
}

export function gradeOf(score: number): ReviewGrade {
  return score >= 85
    ? "S"
    : score >= 70
      ? "A"
      : score >= 55
        ? "B"
        : score >= 40
          ? "C"
          : "D";
}

export function reviewEffect(grade: ReviewGrade): ActionEffect {
  switch (grade) {
    case "S":
      return { stats: { careerPotential: 4 }, status: { confidence: 6 }, exp: 60 };
    case "A":
      return { stats: { careerPotential: 2 }, status: { confidence: 4 }, exp: 40 };
    case "B":
      return { stats: { careerPotential: 1 }, status: { confidence: 1 }, exp: 20 };
    case "C":
      return { status: { mood: -3, stress: 4 } };
    case "D":
      return { status: { confidence: -4, mood: -5, stress: 5, health: -3 } };
  }
}

// --- 자기개발 부족 페널티 (PRD 5.4) ---

export function selfDevPenaltyEffect(
  selfDevCount: number,
  stage: LifeStage,
): ActionEffect {
  // 자기개발이 아직 해금되지 않은 단계(아기~중학생)는 페널티 없음
  if (!isActionUnlocked("selfDev", stage)) return {};
  const adult = isAdultStage(stage);

  if (selfDevCount === 0) {
    const stats: Record<string, number> = { discipline: -3, careerPotential: -5 };
    if (adult) {
      stats.careerPotential -= 3; // 성인 가중 (PRD: 직무 스탯 -3% 환산)
      stats.employability = -3;
    }
    return {
      stats: stats as unknown as ActionEffect["stats"],
      status: { confidence: -2 },
    };
  }
  if (selfDevCount < 3) {
    return { stats: { discipline: -1, careerPotential: -2 } };
  }
  if (selfDevCount >= 10) {
    return { stats: { careerPotential: 3 }, status: { confidence: 2 } };
  }
  return {}; // 3~9 중립
}

// --- 핵심: 밀린 연간 리뷰 처리 (멱등 + 다년 점프 안전) ---

export function runDueReviews(
  c: Character,
  now: number,
): { character: Character; reviews: YearlyReview[] } {
  if (c.deathAge != null) return { character: c, reviews: [] }; // 사망 시 종료
  const age = c.ageYears;
  const last = c.lastReviewedAge;
  if (age <= last) return { character: c, reviews: [] }; // 멱등 no-op

  const reviews: YearlyReview[] = [];
  let ch = c;
  const yearsPassed = age - last;
  const multiYear = yearsPassed >= 2;

  // (A) 막 끝난 직전 1년 — 그 해의 나이/단계 기준으로 채점(점프 후 현재 단계가 아님).
  // 미취업이면 jobseeker 로 캡(직장인 전용 페널티가 취준생에게 발동하지 않도록 게이트와 일치).
  const reviewAge = last + 1;
  const reviewStage = cappedStageForAge(reviewAge, ch.job != null);
  const isWorkReview =
    (reviewStage === "employee" ||
      reviewStage === "senior" ||
      reviewStage === "retirement") &&
    !!ch.job &&
    reviewAge > ch.job.hiredAtAge;

  let score: number;
  let grade: ReviewGrade;
  let exam: { score: number; tier: string } | undefined;
  let work: WorkReview | undefined;

  if (isWorkReview) {
    // 직장인: 업무평가가 메인 등급. 공부 안 한다고 페널티 주지 않고 selfDev 페널티만 유지.
    // 다년 오프라인 점프면 감쇠된 status 대신 중립값으로 채점(비직장인 경로와 대칭).
    const res = processWorkReview(ch, reviewAge, Math.random(), multiYear);
    ch = res.character;
    work = res.work ?? undefined;
    score = work?.evalScore ?? 0;
    grade = work?.grade ?? "C";
    ch = applyEffect(ch, selfDevPenaltyEffect(ch.yearCounters.selfDev, reviewStage));
  } else {
    score = scoreYear(ch.yearCounters, ch.status, reviewAge, {
      neutralStatus: multiYear,
      gender: ch.gender,
    });
    grade = gradeOf(score);
    let effect = reviewEffect(grade);
    effect = mergeEffect(
      effect,
      selfDevPenaltyEffect(ch.yearCounters.selfDev, reviewStage),
    );
    if (EDU_STAGES.includes(reviewStage)) {
      const es = computeExamScore(ch, Math.random());
      const tier = examTier(es);
      exam = { score: es, tier };
      effect = mergeEffect(effect, examEffect(tier, reviewStage));
    }
    ch = applyEffect(ch, effect);
  }

  // 저축·행복 갱신(직전 1년) — 가족(배우자/자녀)·주거 안정감(전세/자가)이 행복에 소폭 추가
  let yearSavingsDelta = yearlyNet(ch);
  const familyWarmth =
    (ch.marriedAtAge != null ? 1 : 0) + Math.min(2, (ch.childrenBornAges ?? []).length);
  ch = {
    ...ch,
    savings: ch.savings + yearSavingsDelta,
    happiness: clamp(
      updateHappiness(ch.happiness, ch.status) + familyWarmth + housingHappiness(ch.housing),
      0,
      100,
    ),
  };
  // 대학 등록금/학자금대출 처리(재학 중이면 등록금 청구, 취업 후면 대출 자동 상환)
  const uni = processUniversityYear(ch, reviewAge);
  ch = uni.character;
  yearSavingsDelta += uni.savingsDelta;
  // 주거비 처리(월세/대출이자/원금상환/집값상승)
  const hy = processHousingYear(ch);
  ch = hy.character;
  yearSavingsDelta += hy.savingsDelta;
  // 위험 이벤트: 대부분 회복 가능한 사고/병, 드물게 사망
  let incident: { cause: string; healthHit: number } | undefined;
  let death: { cause: string } | undefined;
  // 다년 점프면 채점과 동일하게 중립 컨디션으로 위험 평가(잠깐 자리 비웠다고 사망률 폭증 방지)
  const risk = rollLifeRisk(
    ch,
    reviewAge,
    Math.random(),
    Math.random(),
    Math.random(),
    multiYear,
  );
  if (risk.kind === "death") {
    ch = { ...ch, deathAge: Math.min(reviewAge, MAX_AGE), deathCause: risk.cause };
    death = { cause: risk.cause };
  } else if (risk.kind === "incident") {
    ch = applyEffect(ch, { status: { health: -risk.healthHit, stress: 5 } });
    incident = { cause: risk.cause, healthHit: risk.healthHit };
  }

  // 학위: 학사 자동 취득 / 대학원 진행·졸업
  let degreeChange: { to: Degree } | undefined;
  if (ch.deathAge == null) {
    const deg = processDegreeYear(ch, reviewAge);
    ch = deg.ch;
    degreeChange = deg.change;
  }

  // 인생 이벤트: 결혼/출산(마일스톤 우선) 또는 랜덤 이벤트 최대 1건
  let lifeEvent: LifeEventRecord | undefined;
  if (ch.deathAge == null) {
    if (rollMarriage(ch, reviewAge, Math.random())) {
      ch = applyEffect(ch, { status: { mood: 12, confidence: 4, stress: -5 } });
      ch = {
        ...ch,
        marriedAtAge: reviewAge,
        savings: ch.savings - MARRIAGE_COST,
        happiness: clamp(ch.happiness + 4, 0, 100),
      };
      yearSavingsDelta -= MARRIAGE_COST;
      lifeEvent = {
        key: "marriage",
        emoji: "💍",
        label: "결혼",
        detail: `${reviewAge}살, 평생을 함께할 사람과 결혼식을 올렸어요!`,
        savingsDelta: -MARRIAGE_COST,
      };
    } else if (rollChildbirth(ch, reviewAge, Math.random())) {
      const nth = (ch.childrenBornAges ?? []).length + 1;
      ch = applyEffect(ch, { status: { mood: 10, energy: -8 } });
      ch = {
        ...ch,
        childrenBornAges: [...(ch.childrenBornAges ?? []), reviewAge],
        savings: ch.savings - CHILDBIRTH_COST,
        happiness: clamp(ch.happiness + 5, 0, 100),
      };
      yearSavingsDelta -= CHILDBIRTH_COST;
      lifeEvent = {
        key: "childbirth",
        emoji: "👶",
        label: nth === 1 ? "첫 아이 탄생" : "둘째 탄생",
        detail: `${reviewAge}살, ${nth === 1 ? "첫" : "둘째"} 아이가 태어났어요!`,
        savingsDelta: -CHILDBIRTH_COST,
      };
    } else {
      const ev = rollYearlyEvent(ch, reviewAge, Math.random(), Math.random());
      if (ev) {
        if (ev.effect) ch = applyEffect(ch, ev.effect);
        ch = {
          ...ch,
          savings: ch.savings + ev.savingsDelta,
          happiness: clamp(ch.happiness + ev.happinessDelta, 0, 100),
        };
        yearSavingsDelta += ev.savingsDelta;
        lifeEvent = ev.record;
      }
    }
  }

  reviews.push({
    id: `${c.id}:${reviewAge}`,
    age: reviewAge,
    stage: reviewStage,
    kind: "normal",
    counters: { ...c.yearCounters },
    score,
    grade,
    exam,
    work,
    event: lifeEvent,
    incident,
    death,
    degreeChange,
    selfDevPenaltyApplied: true,
    salaryBonusForfeited:
      isAdultStage(reviewStage) && c.yearCounters.selfDev === 0
        ? true
        : undefined,
    savingsDelta: yearSavingsDelta,
    createdAt: now,
  });

  // (B) 건너뛴 중간 연도 — 방치 요약 (직전 1년에 사망하지 않았을 때만)
  if (multiYear && ch.deathAge == null) {
    // 페널티 단계는 갭 대표(중간) 나이 기준 — 점프 후 단계로 학생 연도까지 성인 가중되는 것 방지
    const midAge = reviewAge + Math.floor((yearsPassed - 1) / 2);
    const stage = cappedStageForAge(midAge, ch.job != null);
    const effective = Math.min(yearsPassed - 1, MAX_NEGLECT_YEARS_APPLIED);
    const neglectEffect = scaleEffect(
      selfDevPenaltyEffect(0, stage),
      0.5 * effective,
    );
    ch = applyEffect(ch, neglectEffect);

    // 갭 연도를 한 해씩 굴린다: 매년 저축 + 위험(중립 컨디션). 첫 사망 시 그 해를 deathAge 로.
    // 연속 플레이와 동일하게 매년 굴려야 누적 사망확률(1-∏(1-p_y))이 보존됨(오프라인 치트 방지).
    let gapDeath: { cause: string } | undefined;
    let gapDegreeChange: { to: Degree } | undefined;
    let gapSavingsDelta = 0;
    const lastGapYear = Math.min(age, MAX_AGE);
    for (let y = reviewAge + 1; y <= lastGapYear && ch.deathAge == null; y++) {
      const net = yearlyNet(ch);
      ch = { ...ch, savings: ch.savings + net };
      gapSavingsDelta += net;
      const uniGap = processUniversityYear(ch, y);
      ch = uniGap.character;
      gapSavingsDelta += uniGap.savingsDelta;
      const hyGap = processHousingYear(ch);
      ch = hyGap.character;
      gapSavingsDelta += hyGap.savingsDelta;
      const gr = rollLifeRisk(ch, y, Math.random(), Math.random(), Math.random(), true);
      if (gr.kind === "death") {
        ch = { ...ch, deathAge: Math.min(y, MAX_AGE), deathCause: gr.cause };
        gapDeath = { cause: gr.cause };
      } else if (gr.kind === "incident") {
        ch = applyEffect(ch, { status: { health: -gr.healthHit, stress: 5 } });
      }
      if (ch.deathAge == null) {
        const deg = processDegreeYear(ch, y);
        ch = deg.ch;
        if (deg.change) gapDegreeChange = deg.change;
      }
    }
    reviews.push({
      id: `${c.id}:neglect:${age}`,
      age: ch.deathAge ?? age,
      stage,
      kind: "neglected",
      counters: { ...ZERO_COUNTERS },
      score: 0,
      grade: "D",
      death: gapDeath,
      degreeChange: gapDegreeChange,
      selfDevPenaltyApplied: true,
      neglectedYears: yearsPassed - 1,
      savingsDelta: gapSavingsDelta,
      createdAt: now,
    });
  }

  // (C) 리셋 + 기록 누적(영속). id 중복 방지 + 최근 100건 유지.
  const existingIds = new Set((ch.reviews ?? []).map((r) => r.id));
  const fresh = reviews.filter((r) => !existingIds.has(r.id));
  ch = {
    ...ch,
    reviews: [...(ch.reviews ?? []), ...fresh].slice(-100),
    yearCounters: { ...ZERO_COUNTERS },
    lastReviewedAge: age,
  };
  return { character: ch, reviews: fresh };
}
