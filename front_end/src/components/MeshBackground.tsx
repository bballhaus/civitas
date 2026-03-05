export function MeshBackground() {
  return (
    <div className="absolute inset-0 pointer-events-none z-0">
      <div className="absolute -top-24 -left-24 w-[600px] h-[600px] bg-[radial-gradient(circle,_rgba(147,197,253,0.25)_0%,_transparent_70%)]" />
      <div className="absolute top-[30%] -right-20 w-[500px] h-[500px] bg-[radial-gradient(circle,_rgba(165,180,252,0.2)_0%,_transparent_70%)]" />
      <div className="absolute -bottom-32 left-[20%] w-[550px] h-[550px] bg-[radial-gradient(circle,_rgba(125,211,252,0.22)_0%,_transparent_70%)]" />
      <div className="absolute top-[15%] left-[45%] w-[400px] h-[400px] bg-[radial-gradient(circle,_rgba(191,219,254,0.18)_0%,_transparent_65%)]" />
      <div className="absolute bottom-[25%] right-[10%] w-[350px] h-[350px] bg-[radial-gradient(circle,_rgba(186,230,253,0.2)_0%,_transparent_70%)]" />
    </div>
  );
}
