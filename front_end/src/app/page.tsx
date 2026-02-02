"use client";

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Navigation */}
      <nav className="sticky top-0 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src="/logo.png"
              alt="Civitas logo"
              className="h-15 w-15"
            />
            <span className="text-2xl font-bold text-slate-900">
              Civitas
            </span>
          </div>


          <div className="flex gap-3">
            <button className="px-4 py-2 text-sm border rounded-md">
              My Profile
            </button>
            <button className="px-4 py-2 text-sm border rounded-md">
              Browse All
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-6 py-20 text-center">
        <h1 className="text-3xl font-bold text-slate-900 mb-4">
          Find the right contracts <br /> 
        </h1>
        <h1 className="text-3xl font-bold text-[#3C89C6] mb-4">
          for your business 
        </h1>
        <p className="text-slate-500 mb-8">
          Discover California state and local government opportunities matched to your capabilities.
        </p>

        {/* Fake search bar */}
        <div className="h-12 max-w-xl mx-auto border rounded-lg bg-white" />
      </section>

      {/* Results */}
      <section className="max-w-7xl mx-auto px-6 pb-20">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              Opportunities
            </h2>
            <p className="text-sm text-slate-500">
              0 opportunities found
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button className="px-3 py-2 text-sm border rounded-md">
              Filters
            </button>

            <select className="px-3 py-2 text-sm border rounded-md bg-white">
              <option>Best Match</option>
              <option>Deadline</option>
              <option>Value</option>
              <option>Newest</option>
            </select>

            <div className="flex border rounded-md overflow-hidden">
              <button className="px-3 py-2 text-sm border-r bg-slate-100">
                Grid
              </button>
              <button className="px-3 py-2 text-sm">
                List
              </button>
            </div>
          </div>
        </div>

        {/* Empty state */}
        <div className="text-center py-24 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900 mb-2">
            No opportunities yet
          </h3>
          <p className="text-slate-500">
            Run a search to see matching opportunities
          </p>
        </div>
      </section>
    </div>
  );
}
