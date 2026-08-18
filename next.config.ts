import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // data/*.json is read with fs at request time — trace it into the function bundle.
  outputFileTracingIncludes: { "/api/**": ["./data/**"] },
};

export default nextConfig;
