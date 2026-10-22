import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./tests/e2e',workers:1,retries:process.env.CI?2:0, // hosted runners occasionally drop a local connection
  use:{headless:true,baseURL:'http://127.0.0.1:5173'},webServer:{command:'npm run dev',url:'http://127.0.0.1:5173',reuseExistingServer:!process.env.CI}});
