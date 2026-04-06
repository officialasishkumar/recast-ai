"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { JobCard } from "@/components/job-card";
import { UploadModal } from "@/components/upload-modal";
import { getJobs, deleteJob as apiDeleteJob, type Job } from "@/lib/api";

export default function DashboardPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Placeholder user stats — in production these come from a /me endpoint
  const minutesUsed = 3.2;
  const minutesQuota = 5;

  useEffect(() => {
    if (!localStorage.getItem("token")) {
      router.push("/login");
      return;
    }
    fetchJobs();
  }, [router]);

  async function fetchJobs() {
    setLoading(true);
    try {
      const data = await getJobs();
      setJobs(data);
    } catch {
      // 401 is handled by the api client
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this project?")) return;
    try {
      await apiDeleteJob(id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch {
      // swallow
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-400">
            Manage your video projects
          </p>
        </div>
        <Button onClick={() => setUploadOpen(true)}>
          <Plus className="h-4 w-4" />
          New Project
        </Button>
      </div>

      {/* Usage meter */}
      <div className="mt-8 rounded-xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-slate-300">
            Usage this month
          </span>
          <span className="text-sm text-slate-400">
            {minutesUsed.toFixed(1)} / {minutesQuota} min
          </span>
        </div>
        <Progress
          value={minutesUsed}
          max={minutesQuota}
          className="mt-3"
        />
      </div>

      {/* Job list */}
      <div className="mt-8">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 py-20 text-center">
            <p className="text-sm text-slate-500">
              No projects yet. Create your first one!
            </p>
            <Button
              className="mt-4"
              size="sm"
              onClick={() => setUploadOpen(true)}
            >
              <Plus className="h-4 w-4" />
              New Project
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>

      {/* Upload modal */}
      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onCreated={() => {
          setUploadOpen(false);
          fetchJobs();
        }}
      />
    </div>
  );
}
