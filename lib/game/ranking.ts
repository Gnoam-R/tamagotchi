import type { Character } from "@/types/character";
import { clamp } from "./clamp";
import { computeLifeScore } from "./ending";
import { BASE_SALARY, GRADE_ORDER } from "./jobs";
import { competency } from "./work";
import { weightVerdict } from "./weight";

const ci = (s: number) => Math.min(Math.max(s, 0), 100);

export type RankCategory = "overall" | "salary" | "career" | "health" | "selfDev";

export interface RankingScores {
  overall: number;
  salary: number;
  career: number;
  health: number;
  selfDev: number;
}

/** 카테고리 메타 + seeded 분포(μ·σ) — 게임 난이도 기반 추정 분포(서버/타인 데이터 없음) */
export const RANK_META: Record<
  RankCategory,
  { label: string; icon: string; mu: number; sigma: number }
> = {
  overall: { label: "종합", icon: "star", mu: 48, sigma: 18 },
  salary: { label: "연봉", icon: "coin", mu: 28, sigma: 18 },
  career: { label: "직무", icon: "briefcase", mu: 42, sigma: 20 },
  health: { label: "건강", icon: "heart", mu: 62, sigma: 16 },
  selfDev: { label: "자기개발", icon: "medal", mu: 45, sigma: 19 },
};

export const RANK_ORDER: RankCategory[] = [
  "overall",
  "salary",
  "career",
  "health",
  "selfDev",
];

function salaryScore(c: Character): number {
  if (!c.job) return 0;
  return clamp((c.job.salaryManwon / BASE_SALARY.ceo) * 100, 0, 100); // ceo 2억=100
}

function careerScore(c: Character): number {
  if (!c.job) return 0;
  const ladder =
    (GRADE_ORDER.indexOf(c.job.grade) / (GRADE_ORDER.length - 1)) * 100;
  return Math.round(ladder * 0.6 + competency(c) * 0.4);
}

function healthScore(c: Character): number {
  const s = c.status;
  const weightOk = weightVerdict(s.weight, c.ageYears, c.gender) === "healthy" ? 100 : 40;
  return Math.round(
    s.health * 0.5 +
      (100 - s.burnout) * 0.2 +
      (100 - s.stress) * 0.15 +
      weightOk * 0.15,
  );
}

function selfDevScore(c: Character): number {
  // 성인기 연간 리뷰에서 selfDev==0(=salaryBonusForfeited) 비율로 평생 충실도 추정.
  // reviews 는 최근 100건 slice 라 누적 스탯을 주가중으로 두어 유실 의존도 완화.
  const adult = (c.reviews ?? []).filter(
    (r) =>
      r.stage === "employee" || r.stage === "senior" || r.stage === "retirement",
  );
  const forfeitRate =
    adult.length > 0
      ? adult.filter((r) => r.salaryBonusForfeited).length / adult.length
      : 0;
  return Math.round(
    ci(c.stats.academic) * 0.3 +
      ci(c.stats.careerPotential) * 0.3 +
      ci(c.stats.employability) * 0.2 +
      (1 - forfeitRate) * 100 * 0.2,
  );
}

/** 현재 캐릭터의 5종 랭킹 점수(0~100). 전부 순수 파생값 — 저장 불필요. */
export function computeRankings(c: Character): RankingScores {
  return {
    overall: computeLifeScore(c),
    salary: Math.round(salaryScore(c)),
    career: careerScore(c),
    health: healthScore(c),
    selfDev: selfDevScore(c),
  };
}

/** 표준정규 누적분포 근사 (Abramowitz & Stegun 26.2.17) */
function normCdf(z: number): number {
  const b1 = 0.31938153,
    b2 = -0.356563782,
    b3 = 1.781477937,
    b4 = -1.821255978,
    b5 = 1.330274429,
    p = 0.2316419,
    c = 0.39894228;
  const az = Math.abs(z);
  const t = 1 / (1 + p * az);
  const phi = c * Math.exp((-az * az) / 2);
  const prob = phi * t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  return z >= 0 ? 1 - prob : prob;
}

/**
 * 추정 상위 X%(작을수록 상위). 입력은 점수뿐 — 결정적·서버호출 0·개인정보 0.
 * 미래 서버 랭킹 도입 시 이 함수만 실제 분포로 교체.
 */
export function percentileFor(cat: RankCategory, score: number): number {
  const { mu, sigma } = RANK_META[cat];
  const z = (score - mu) / sigma;
  const top = (1 - normCdf(z)) * 100; // 점수↑ → 상위% 작아짐
  return clamp(Math.round(top), 1, 99);
}
