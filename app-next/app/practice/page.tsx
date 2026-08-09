import { getAllTopics } from '@/lib/content';
import PracticeView from '@/components/PracticeView';

export const metadata = { title: 'Design Drills — SysDesign Atlas' };

/** Prompts map onto worked solutions where one exists. */
const PROMPTS: { q: string; slug?: string; group: string; star?: boolean }[] = [
  { q: 'Design a URL shortener', slug: 'url-shortener', group: 'Warm-up', star: true },
  { q: 'Design a distributed rate limiter', slug: 'rate-limiter', group: 'Infrastructure', star: true },
  { q: 'Design a distributed cache', slug: 'distributed-cache', group: 'Storage' },
  { q: 'Design a distributed key-value store', slug: 'key-value-store', group: 'Storage', star: true },
  { q: 'Design Twitter / a news feed', slug: 'news-feed', group: 'Fanout', star: true },
  { q: 'Design Instagram', group: 'Fanout' },
  { q: 'Design WhatsApp / Messenger', slug: 'chat-system', group: 'Real-time', star: true },
  { q: 'Design Slack', group: 'Real-time' },
  { q: 'Design a notification system', slug: 'notification-system', group: 'Async' },
  { q: 'Design a distributed job scheduler', slug: 'job-scheduler', group: 'Async', star: true },
  { q: 'Design YouTube / Netflix', slug: 'video-streaming', group: 'Media', star: true },
  { q: 'Design a live streaming platform', group: 'Media' },
  { q: 'Design Uber / ride-sharing', slug: 'ride-sharing', group: 'Geospatial', star: true },
  { q: 'Design a food delivery service', group: 'Geospatial' },
  { q: 'Design a proximity service (Yelp)', group: 'Geospatial' },
  { q: 'Design Ticketmaster / seat booking', slug: 'ticket-booking', group: 'Correctness', star: true },
  { q: 'Design a payment system', slug: 'payment-system', group: 'Correctness', star: true },
  { q: 'Design a digital wallet', group: 'Correctness' },
  { q: 'Design an ad click aggregator', slug: 'ad-click-aggregator', group: 'Streaming', star: true },
  { q: 'Design a metrics & monitoring system', group: 'Streaming' },
  { q: 'Design search autocomplete', slug: 'autocomplete', group: 'Search', star: true },
  { q: 'Design a web crawler', slug: 'web-crawler', group: 'Search' },
  { q: 'Design Google Docs', slug: 'collaborative-editor', group: 'Collaboration', star: true },
  { q: 'Design a shared whiteboard', group: 'Collaboration' },
  { q: 'Design Google Drive / Dropbox', group: 'Storage' },
  { q: 'Design a leaderboard for 100M players', group: 'Streaming' },
  { q: 'Design an A/B testing platform', group: 'Infrastructure' },
  { q: 'Design a feature flag service', group: 'Infrastructure' },
  { q: 'Design a vaccine appointment scheduler', group: 'Product-shaped' },
  { q: 'Design an airline check-in system', group: 'Product-shaped' },
  { q: 'Design a subscription billing system', group: 'Product-shaped' },
  { q: 'Design a warehouse robot task dispatcher', group: 'Product-shaped' },
  { q: 'Design an LLM inference serving platform', slug: 'llm-inference-serving', group: 'AI infrastructure', star: true },
  { q: 'Design a RAG system over 10M documents', slug: 'rag-system', group: 'AI infrastructure', star: true },
  { q: 'Design an agent runtime with tool execution', slug: 'ai-agent-platform', group: 'AI infrastructure', star: true },
  { q: 'Design a GPU cluster scheduler', slug: 'gpu-cluster-scheduling', group: 'AI infrastructure' },
  { q: 'Design a vector search service for 1B embeddings', slug: 'vector-databases', group: 'AI infrastructure' },
  { q: 'Design an evaluation platform for AI changes', slug: 'eval-platform', group: 'AI infrastructure' },
  { q: 'Design a multi-tenant fine-tuning service', slug: 'fine-tuning-platform', group: 'AI infrastructure' },
  { q: 'Design a real-time voice assistant', slug: 'voice-assistant', group: 'AI infrastructure', star: true },
  { q: 'Design a distributed training cluster for a 100B model', slug: 'pretraining-run', group: 'AI infrastructure' },
  { q: 'Design a feature store', slug: 'ml-platform', group: 'AI infrastructure' },
  { q: 'Design a recommendation feed for 100M users', slug: 'ranking-and-recsys', group: 'AI infrastructure', star: true },
  { q: 'Design a content moderation pipeline', group: 'AI infrastructure' },
];

const HOSTILE = [
  'What breaks first at 10× traffic?',
  'Kill your database primary. What happens in the next 60 seconds?',
  'The cache cluster restarts empty under full load. Walk me through it.',
  'This dependency is up but responding in 8 seconds. What does your system do?',
  'Can this ever double-charge, double-book, or double-send?',
  'Two users do this at exactly the same instant. What happens?',
  'The client retries after a timeout. Is that safe?',
  'Why not just one Postgres box?',
  'Can you remove a component and still meet the requirements?',
  'What would you build with three engineers in six weeks?',
  'How would you know this is broken before a user tells you?',
  'How do you deploy this without downtime?',
  'How do you migrate from the existing system to this one?',
  'There is a network partition between your two regions. Now what?',
  'What does this cost per month, roughly?',
  'A user submits a 200,000-token prompt. What happens to everyone else?',
  'A GPU node dies mid-batch. What do the requests on it experience?',
  'What is your cost per user per month, and where does it go?',
  'The embedding model needs upgrading. Walk me through the migration.',
  'Your agent loops 40 times on one request. What stopped it, and what did it cost?',
  'How do you know the model got worse after a deploy?',
  'Untrusted text in a retrieved document says "ignore your instructions". What saves you?',
];

export default function PracticePage() {
  const topics = getAllTopics();
  const bySlug = new Map(topics.map((t) => [t.slug, t]));

  const prompts = PROMPTS.map((p) => ({
    ...p,
    href: p.slug && bySlug.has(p.slug)
      ? `/learn/${bySlug.get(p.slug)!.section.slug}/${p.slug}`
      : undefined,
  }));

  return <PracticeView prompts={prompts} hostile={HOSTILE} />;
}
