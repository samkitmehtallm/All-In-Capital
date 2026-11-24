/** @type {import('next').NextConfig} */
const nextConfig = {
  // The local store and the Supabase adapter both use node APIs and hold the
  // service key. Keeping them server-only is enforced here as well as by import
  // discipline, so a stray client import fails the build rather than shipping.
  serverExternalPackages: ['unpdf'],
};
export default nextConfig;
