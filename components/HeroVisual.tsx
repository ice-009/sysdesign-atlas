'use client';

import { motion } from 'motion/react';

/* Animated architecture diagram used as the landing hero.
   Pure SVG — draws a request flowing through a distributed system. */

const NODES = [
  { id: 'client', x: 40, y: 130, label: 'Client', w: 62 },
  { id: 'edge', x: 138, y: 130, label: 'CDN', w: 56 },
  { id: 'lb', x: 230, y: 130, label: 'LB', w: 48 },
  { id: 'api', x: 316, y: 70, label: 'API', w: 52 },
  { id: 'api2', x: 316, y: 130, label: 'API', w: 52 },
  { id: 'api3', x: 316, y: 190, label: 'API', w: 52 },
  { id: 'cache', x: 418, y: 70, label: 'Cache', w: 62 },
  { id: 'queue', x: 418, y: 190, label: 'Queue', w: 62 },
  { id: 'db1', x: 530, y: 100, label: 'Shard 1', w: 68 },
  { id: 'db2', x: 530, y: 160, label: 'Shard 2', w: 68 },
];

const EDGES: [string, string][] = [
  ['client', 'edge'],
  ['edge', 'lb'],
  ['lb', 'api'],
  ['lb', 'api2'],
  ['lb', 'api3'],
  ['api', 'cache'],
  ['api2', 'cache'],
  ['api3', 'queue'],
  ['cache', 'db1'],
  ['api2', 'db1'],
  ['queue', 'db2'],
  ['api2', 'db2'],
];

const byId = (id: string) => NODES.find((n) => n.id === id)!;

export default function HeroVisual() {
  return (
    <svg
      viewBox="0 0 640 270"
      className="w-full h-auto max-w-2xl"
      role="img"
      aria-label="Animated diagram of a request flowing through a distributed system"
    >
      <defs>
        <linearGradient id="edgeGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.15" />
          <stop offset="50%" stopColor="#38bdf8" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id="nodeGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.07" />
        </linearGradient>
        <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>

      {/* connections */}
      {EDGES.map(([a, b], i) => {
        const from = byId(a);
        const to = byId(b);
        const x1 = from.x + from.w;
        const y1 = from.y + 14;
        const x2 = to.x;
        const y2 = to.y + 14;
        const mid = (x1 + x2) / 2;
        const d = `M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
        return (
          <g key={`${a}-${b}`}>
            <path d={d} stroke="url(#edgeGrad)" strokeWidth="1.4" fill="none" />
            <motion.circle
              r="2.6"
              fill="#38bdf8"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 1, 1, 0] }}
              transition={{
                duration: 2.4,
                repeat: Infinity,
                delay: i * 0.32,
                ease: 'linear',
              }}
            >
              <animateMotion dur="2.4s" repeatCount="indefinite" begin={`${i * 0.32}s`} path={d} />
            </motion.circle>
          </g>
        );
      })}

      {/* nodes */}
      {NODES.map((n, i) => (
        <motion.g
          key={n.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.06 * i, duration: 0.45, ease: [0.2, 0, 0, 1] }}
        >
          <rect
            x={n.x}
            y={n.y}
            width={n.w}
            height={28}
            rx={7}
            fill="url(#nodeGrad)"
            stroke="#38bdf8"
            strokeOpacity="0.35"
            strokeWidth="1"
          />
          <text
            x={n.x + n.w / 2}
            y={n.y + 18}
            textAnchor="middle"
            fontSize="10.5"
            fontFamily="ui-monospace, monospace"
            fill="currentColor"
            opacity="0.82"
          >
            {n.label}
          </text>
          <motion.circle
            cx={n.x + n.w - 7}
            cy={n.y + 6.5}
            r="2"
            fill="#4ade80"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 2, repeat: Infinity, delay: i * 0.18 }}
          />
        </motion.g>
      ))}

      {/* glow accents */}
      <circle cx="180" cy="120" r="34" fill="#38bdf8" opacity="0.1" filter="url(#soft)" />
      <circle cx="520" cy="150" r="40" fill="#a78bfa" opacity="0.09" filter="url(#soft)" />
    </svg>
  );
}
