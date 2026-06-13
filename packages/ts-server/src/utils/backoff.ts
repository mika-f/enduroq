export interface BackoffParams {
  base: number;
  cap: number;
  jitter: number;
}

export const compute = ({
  attempt,
  params,
}: {
  attempt: number;
  params: BackoffParams;
}): number => {
  return (
    Math.min(params.cap, params.base * 2 ** attempt) +
    Math.floor(Math.random() * params.jitter)
  );
};
