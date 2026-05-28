// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	integrations: [
		starlight({
			title: 'Omkar Shendge',
			description: 'Backend engineer building toward AI infrastructure',
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
					label: 'Engineering',
					items: [
						{ autogenerate: { directory: 'engineering' } },
					],
				},
			],
		}),
	],
});