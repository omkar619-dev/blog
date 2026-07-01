// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	integrations: [
		starlight({
			title: 'Omkar Shendge',
			description: 'Backend engineer building toward AI infrastructure',
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
						{ autogenerate: { directory: 'projects' } },
					],
				},
				{
					label: 'Incidents',
					items: [
						{ autogenerate: { directory: 'incidents' } },
					],
				},
				{
					label: 'Musings',
					items: [
						{ autogenerate: { directory: 'musings' } },
					],
				},
			],
		}),
	],
});
