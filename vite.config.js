import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served from the root of jobs.imetrobert.com (its own GitHub Pages site),
// so base stays '/' — unlike a project site served from /repo-name/.
export default defineConfig({
  plugins: [react()],
  base: '/',
})
