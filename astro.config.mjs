// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	integrations: [
		starlight({
			title: 'Omkar Shendge',
			description: 'Backend engineer building toward AI infrastructure',
			customCss: ['./src/styles/custom.css'],
			head: [
				{
				  tag: 'script',
				  attrs: {
					src: 'https://static.cloudflareinsights.com/beacon.min.js',
					'data-cf-beacon': '{"token": "aa4dc47d7b12470e97772185d49b0bf8"}',
					defer: true,
				  },
				},
			  ],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/omkar619-dev' },
				{ icon: 'linkedin', label: 'LinkedIn', href: 'https://www.linkedin.com/in/omkar-shendge-43784612b/' },
			],
			sidebar: [
				{
					label: 'Projects',
					items: [
						{
							// Ordered as the system was actually built, not alphabetically.
							label: 'News Feed (Go)',
							collapsed: false,
							items: [
								'projects/choosing-postgres-pgvector-over-mongodb',
								'projects/designing-news-feed-schema',
								'projects/threaded-comments-recursive-cte',
								'projects/likes-and-the-hot-counter-problem',
								'projects/fanning-out-the-feed-with-rabbitmq',
								'projects/idempotency-keys-and-the-retried-post',
								'projects/the-dual-write-bug-and-the-outbox',
								'projects/offsets-record-how-far-you-got',
								'projects/semantic-search-and-ranking',
								'projects/hybrid-search-and-the-honest-eval',
								'projects/you-cant-judge-retrieval-by-the-answer',
								'projects/catching-astroturf-with-embeddings',
								'projects/a-social-feed-you-ssh-into',
							],
						},
						{
							label: 'Distributed Systems',
							collapsed: true,
							items: [
								'projects/mapreduce-mit-6584-lab1',
								'projects/kv-server-lock-mit-6584-lab2',
							],
						},
						{
							label: 'Platform & Homelab',
							collapsed: true,
							items: [
								'projects/k8s-deployment',
								'projects/gitops-argocd-homelab',
								'projects/crashlooping-controller-and-the-missing-crd',
							],
						},
					],
				},
				{
					// Newest first — the most recent breakage is the most relevant.
					label: 'Incidents',
					collapsed: false,
					items: [
						'incidents/the-flag-that-renamed-my-clusters-database',
						'incidents/kafkas-two-addresses',
						'incidents/the-machine-didnt-move-its-address-did',
						'incidents/pascal-legacy-driver-and-the-53x-speedup',
						'incidents/argocd-sealed-secrets-handoff',
						'incidents/dns-server-misbehaving',
					],
				},
				{
					label: 'Musings',
					collapsed: true,
					items: [
						'musings/dont-throw-the-party-before-the-fight',
						'musings/wake-me-when-the-world-cup-starts',
						'musings/this-time-for-africa',
						'musings/who-killed-joga-bonito',
					],
				},
			],
		}),
	],
});
