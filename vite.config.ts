import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: adapter(),

			csrf: {
				// Loopback origins may always submit forms, so a plain
				// `docker compose up` works via localhost AND 127.0.0.1 without
				// setting ORIGIN. Safe to trust: a browser never lets a foreign
				// page fake its Origin header, and the session cookie is
				// SameSite=Lax so cross-site POSTs arrive unauthenticated anyway.
				// Any other address (host port != 3000, LAN IP, reverse proxy)
				// still requires ORIGIN — see README.
				trustedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']
			}
		})
	]
});
