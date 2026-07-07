import type { Character, Gender } from "@/types/character";
import { HEALTHY_WEIGHT_FEMALE, HEALTHY_WEIGHT_MALE } from "./constants";
import { stageForAge } from "./growth";

export type WeightVerdict = "low" | "healthy" | "high";

export function healthyRangeForAge(age: number, gender: Gender = "male"): [number, number] {
  const table = gender === "female" ? HEALTHY_WEIGHT_FEMALE : HEALTHY_WEIGHT_MALE;
  return table[stageForAge(age)];
}

/** 나이대 적정 범위의 중간값 — 자연 성장이 향하는 "평균 몸무게" 기준점 */
export function averageWeightForAge(age: number, gender: Gender = "male"): number {
  const [lo, hi] = healthyRangeForAge(age, gender);
  return (lo + hi) / 2;
}

export function weightVerdict(weight: number, age: number, gender: Gender = "male"): WeightVerdict {
  const [lo, hi] = healthyRangeForAge(age, gender);
  if (weight < lo) return "low";
  if (weight > hi) return "high";
  return "healthy";
}

export function weightVerdictLabel(v: WeightVerdict): string {
  return v === "low" ? "저체중" : v === "high" ? "과체중" : "적정";
}

/** 픽셀 스프라이트 체형 — 저체중=slim, 과체중=heavy (스프라이트 몸통 폭에 반영) */
export type BodyShape = "slim" | "normal" | "heavy";

export function bodyShapeForWeight(weight: number, age: number, gender: Gender = "male"): BodyShape {
  const v = weightVerdict(weight, age, gender);
  return v === "low" ? "slim" : v === "high" ? "heavy" : "normal";
}

/**
 * 몸무게가 적정 범위를 벗어났을 때의 시간 경과 페널티(틱마다 적용).
 * PRD: 초과 시 health -2 / 저체중 시 health -3, focus -2 등.
 * 틱 단위로 너무 급격하지 않게 시간 비례로 적용한다.
 */
export function weightTickPenalty(
  weight: number,
  age: number,
  hours: number,
  gender: Gender = "male",
): { health: number; focus: number; energy: number } {
  const v = weightVerdict(weight, age, gender);
  if (v === "high") {
    return { health: -1.0 * hours, focus: 0, energy: -0.3 * hours };
  }
  if (v === "low") {
    return { health: -1.2 * hours, focus: -0.6 * hours, energy: -0.6 * hours };
  }
  return { health: 0, focus: 0, energy: 0 };
}

/** 운동/식사 효율에 곱해지는 몸무게 보정 (적정 범위 밖이면 효율 -10%) */
export function weightEfficiencyMultiplier(c: Character): number {
  const v = weightVerdict(c.status.weight, c.ageYears, c.gender);
  return v === "healthy" ? 1 : 0.9;
}
