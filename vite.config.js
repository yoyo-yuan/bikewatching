import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	build: {
		rollupOptions: {
			external: ['mapbox-gl'],
			output: {
				globals: {
					'mapbox-gl': 'mapboxgl'
				}
			}
		}
	}
});
